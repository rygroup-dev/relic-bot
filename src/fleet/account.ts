/**
 * One account's lifecycle: authenticate, join a zone, play, sell.
 *
 * Every value-producing branch runs through `free()`, which consults park
 * state first. That is a structural guarantee, not a convention: there is no
 * other path to performing work, so a new branch cannot forget the check.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import type { Account } from '../wallet/keystore.js';
import { AuthClient, BannedError, type Session } from '../auth/client.js';
import { ZoneConnection, zoneEndpoint } from '../net/zone.js';
import { MSG, ROOM } from '../protocol/messages.js';
import { free, ParkRegistry } from '../safety/park.js';
import { Ledger, CombatMemory } from '../safety/ledger.js';
import { Otak } from '../otak/index.js';
import { GateChecker, type GateStatus } from '../economy/gate.js';
import { Marketplace, type SellableItem } from '../economy/marketplace.js';
import {
  combatCandidates,
  lootCandidates,
  parseCandidateId,
  DEFAULT_COMBAT_TUNING,
} from '../game/combat.js';
import { readEntities, readSelf, describeUnknownState, type SelfView } from '../game/state.js';
import { logger, type Logger } from '../log.js';
import type { Config } from '../config.js';

export type AccountPhase =
  | 'idle'
  | 'authenticating'
  | 'connecting'
  | 'playing'
  | 'parked'
  | 'banned'
  | 'stopped';

export interface AccountStatus {
  id: string;
  address: string;
  phase: AccountPhase;
  gate: GateStatus | null;
  lastValueAt: number;
  battles: number;
  listings: number;
  note: string;
}

export interface AccountDeps {
  cfg: Config;
  auth: AuthClient;
  parks: ParkRegistry;
  ledger: Ledger;
  combat: CombatMemory;
  otak: Otak;
  gate: GateChecker;
  market: Marketplace;
}

export class AccountRunner {
  private log: Logger;
  private phase: AccountPhase = 'idle';
  private session: Session | null = null;
  private zone: ZoneConnection | null = null;
  private latestState: unknown = null;
  private stateDumped = false;
  private listings = 0;
  private note = '';
  private stopping = false;
  private gateStatus: GateStatus | null = null;

  constructor(
    readonly account: Account,
    private readonly d: AccountDeps,
  ) {
    this.log = logger(`acct:${account.id}`);
  }

  status(): AccountStatus {
    return {
      id: this.account.id,
      address: this.account.address,
      phase: this.phase,
      gate: this.gateStatus,
      lastValueAt: this.d.ledger.lastValueAt(this.account.id),
      battles: this.d.combat.totalBattles(this.account.id),
      listings: this.listings,
      note: this.note,
    };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.zone?.leave(true);
    this.phase = 'stopped';
  }

  /** Randomised delay so the fleet does not act on a single synchronised beat. */
  private async tempo(): Promise<void> {
    const base = this.d.cfg.ACTION_TEMPO_MS;
    const jitter = (this.d.cfg.ACTION_JITTER_PCT / 100) * base;
    const ms = base + (Math.random() * 2 - 1) * jitter;
    await sleep(Math.max(200, Math.round(ms)));
  }

  async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.sessionCycle();
      } catch (err) {
        if (err instanceof BannedError) {
          this.phase = 'banned';
          this.note = err.ban.reason;
          this.d.parks.park({
            scope: 'account',
            accountId: this.account.id,
            key: 'banned',
            reason: err.message,
            cooldownMs: Infinity,
            needsOperator: true,
          });
          this.log.error(err.message);
          return; // a banned account never retries
        }
        this.log.warn(`cycle ended: ${(err as Error).message}`);
        this.d.parks.parkFromRefusal(this.account.id, 'session', err);
      }
      if (this.stopping) break;
      this.phase = 'parked';
      await sleep(30_000);
    }
  }

  private async sessionCycle(): Promise<void> {
    this.phase = 'authenticating';
    this.session = await this.d.auth.login(this.account);

    this.gateStatus = await this.d.gate.check(
      this.account.id,
      this.session.token,
      this.account.address,
    );
    if (!this.gateStatus.allowed) {
      this.note = 'token gate CLOSED - market features unavailable, still farming';
      this.log.warn(this.note);
    }

    this.phase = 'connecting';
    const zone = new ZoneConnection({
      endpoint: zoneEndpoint(this.d.cfg.RELIC_BASE_URL),
      room: ROOM.TOWN,
      token: this.session.token,
      ...(this.session.character?.name ? { name: this.session.character.name } : {}),
      ...(this.session.character?.classId ? { classId: this.session.character.classId } : {}),
    });

    zone.onState((s) => {
      this.latestState = s;
      if (!this.stateDumped) {
        this.stateDumped = true;
        this.log.debug(`observed state shape:\n${describeUnknownState(s)}`);
      }
    });
    zone.onMessage((type, payload) => this.observe(type, payload));

    let left = false;
    zone.onLeave(() => {
      left = true;
    });

    await zone.connect();
    this.zone = zone;
    this.phase = 'playing';

    let ticks = 0;
    while (!this.stopping && !left && zone.connected) {
      await this.tick();
      await this.tempo();
      if (++ticks % 60 === 0) await this.sellCycle();
    }

    await zone.leave(true);
    this.zone = null;
  }

  /** Server messages we can attribute value to. */
  private observe(type: string, payload: unknown): void {
    const t = type.toLowerCase();
    if (/loot|drop|pickup/.test(t)) {
      this.d.ledger.append({
        accountId: this.account.id,
        kind: 'loot',
        detail: safeLabel(payload) ?? type,
      });
    } else if (/kill|slain|death|defeat/.test(t)) {
      const monster = safeLabel(payload) ?? 'unknown';
      this.d.combat.record(this.account.id, monster, 'win');
      this.d.ledger.append({ accountId: this.account.id, kind: 'kill', detail: monster });
    } else if (/gold|coin/.test(t)) {
      const g = typeof payload === 'number' ? payload : undefined;
      this.d.ledger.append({
        accountId: this.account.id,
        kind: 'gold',
        detail: type,
        ...(g !== undefined ? { gold: g } : {}),
      });
    }
  }

  /** One decision + action. */
  private async tick(): Promise<void> {
    const zone = this.zone;
    if (!zone?.connected) return;

    const entities = readEntities(this.latestState);
    const self: SelfView = readSelf(this.latestState, zone.sessionId);

    // Loot first: pure gain, no combat risk.
    const loot = lootCandidates(self, entities);
    if (loot.length > 0) {
      const outcome = await free(this.d.parks, this.account.id, 'loot', async () => {
        const decision = await this.d.otak.decide({
          domain: 'economy',
          situation: `${loot.length} loot pile(s) in reach`,
          candidates: loot,
        });
        if (!decision.chosenId) return false;
        const parsed = parseCandidateId(decision.chosenId);
        if (!parsed) return false;
        zone.send(MSG.LOOT_PICKUP, { id: parsed.target });
        return true;
      });
      if (outcome.ran && outcome.value) return;
    }

    const targets = combatCandidates(
      self,
      entities,
      this.d.combat,
      this.account.id,
      DEFAULT_COMBAT_TUNING,
    );

    if (targets.length === 0) {
      this.note = 'no engageable target (hurt, or nothing in reach)';
      return;
    }

    await free(this.d.parks, this.account.id, 'combat', async () => {
      const decision = await this.d.otak.decide({
        domain: 'combat',
        situation: `hp=${self.hp ?? '?'} / ${self.maxHp ?? '?'}, ${targets.length} target(s) in reach`,
        candidates: targets,
        constraints: ['Do not engage if the risk outweighs the reward; returning null is fine.'],
      });
      if (!decision.chosenId) {
        this.note = `otak declined: ${decision.reasoning}`;
        return;
      }
      const parsed = parseCandidateId(decision.chosenId);
      if (!parsed) return;
      this.note = `attacking ${parsed.target} (${decision.source})`;
      zone.send(MSG.ATTACK, { targetId: parsed.target });
    });
  }

  /**
   * Sell farmed loot. The bot's only revenue channel - and it needs no
   * signature, which is exactly why it works under the payment hard-lock.
   */
  private async sellCycle(): Promise<void> {
    if (!this.d.cfg.SELL_ENABLED || !this.session) return;
    if (this.gateStatus && !this.gateStatus.allowed) return;

    await free(this.d.parks, this.account.id, 'sell', async () => {
      const token = this.session!.token;
      const items = this.sellableInventory();
      if (items.length === 0) return;

      type Priced = {
        item: SellableItem;
        price: NonNullable<Awaited<ReturnType<Marketplace['priceFor']>>>;
      };
      const priced: Priced[] = [];
      for (const item of items) {
        const price = await this.d.market.priceFor(token, item, {
          minNetMicroUsdc: BigInt(Math.round(this.d.cfg.SELL_MIN_NET_MICRO_USDC)),
          relicVolatilityDiscountPct: this.d.cfg.RELIC_VOLATILITY_DISCOUNT_PCT,
          preference: this.d.cfg.SELL_CURRENCY_PREFERENCE,
        });
        if (price) priced.push({ item, price });
      }
      if (priced.length === 0) return;

      const decision = await this.d.otak.decide({
        domain: 'economy',
        situation: `${priced.length} item(s) priced above the floor and ready to list`,
        candidates: priced.map((p, i) => ({
          id: `sell:${i}`,
          label: `list ${p.item.name} for ${p.price.priceMicroUsdc} micro ${p.price.currency}`,
          score: Number(p.price.netMicroUsdc) / 1e6,
          rationale: p.price.reason,
          facts: {
            currency: p.price.currency,
            netMicroUsdc: p.price.netMicroUsdc.toString(),
            comparables: p.price.comparableCount,
          },
        })),
        constraints: [
          'RELIC listings pay a 5% fee, USDC listings 10%, both seller-paid.',
          'Prefer a sale that actually clears over an optimistic price that sits unsold.',
        ],
      });

      if (!decision.chosenId) return;
      const idx = Number(decision.chosenId.split(':')[1]);
      const chosen = priced[idx];
      if (!chosen) return;

      const res = await this.d.market.createListing(token, chosen.item, chosen.price);
      if (res.ok) {
        this.listings += 1;
        this.d.ledger.append({
          accountId: this.account.id,
          kind: 'sale_listed',
          detail: chosen.item.name,
          microUsdc: chosen.price.netMicroUsdc.toString(),
        });
      } else {
        throw new Error(`listing refused: ${res.reason}`);
      }
    });
  }

  /**
   * Inventory items worth listing.
   *
   * The inventory lives in room state whose schema is runtime-reflected, so
   * this reads defensively and returns nothing when the shape is unrecognised
   * rather than inventing item ids. Verify against a live session before
   * trusting SELL_ENABLED in production.
   */
  private sellableInventory(): SellableItem[] {
    const state = this.latestState;
    if (!state || typeof state !== 'object') return [];
    const rec = state as Record<string, unknown>;
    const inv = rec.inventory ?? rec.items;
    if (!inv || typeof inv !== 'object') return [];

    const out: SellableItem[] = [];
    for (const [key, v] of Object.entries(inv as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const r = v as Record<string, unknown>;
      const name = typeof r.name === 'string' ? r.name : null;
      if (!name) continue;
      const instanceId = typeof r.instanceId === 'string' ? r.instanceId : null;
      const itemId = typeof r.itemId === 'string' ? r.itemId : key;
      out.push(
        instanceId
          ? { kind: 'instance', instanceId, name, ...optional(r) }
          : {
              kind: 'stack',
              itemId,
              quantity: typeof r.quantity === 'number' ? r.quantity : 1,
              name,
              ...optional(r),
            },
      );
    }
    return out;
  }
}

function optional(r: Record<string, unknown>): Partial<SellableItem> {
  const o: Partial<SellableItem> = {};
  if (typeof r.category === 'string') o.category = r.category;
  if (typeof r.slot === 'string') o.slot = r.slot;
  if (typeof r.rarity === 'string') o.rarity = r.rarity;
  return o;
}

function safeLabel(payload: unknown): string | null {
  if (typeof payload === 'string') return payload.slice(0, 64);
  if (payload && typeof payload === 'object') {
    const r = payload as Record<string, unknown>;
    for (const k of ['name', 'monster', 'monsterId', 'itemId', 'id', 'label']) {
      if (typeof r[k] === 'string') return (r[k] as string).slice(0, 64);
    }
  }
  return null;
}
