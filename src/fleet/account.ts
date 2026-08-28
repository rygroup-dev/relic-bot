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
import { enterSoloDungeon, EntryDeniedError, DUNGEON_IN, VALUE_SIGNALS } from '../net/lobby.js';
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
import { loadWorldMap, dungeonEntrance, findPath, type Cell } from '../game/world.js';
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
  /** Live character vitals, when the wallet is in a room. */
  vitals: {
    hp: number | null;
    maxHp: number | null;
    mana: number | null;
    maxMana: number | null;
    level: number | null;
    gold: number | null;
    depth: number | null;
  };
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
  /** Monotonic move sequence, as the client sends with every i.move. */
  private moveSeq = 0;

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
      vitals: this.vitals(),
    };
  }

  /** Read vitals straight from the latest room state. */
  private vitals(): AccountStatus['vitals'] {
    const s = readSelf(this.latestState, this.zone?.sessionId ?? null);
    return {
      hp: s.hp,
      maxHp: s.maxHp,
      mana: s.mana,
      maxMana: s.maxMana,
      level: s.level,
      gold: s.gold,
      depth: s.depth,
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

      // Read the park we just wrote. Without this the loop re-authenticates
      // every 30s forever on a refusal that retrying can never fix (an
      // indefinitely parked `no_character` wallet was doing exactly that, and
      // the resulting auth storm rate-limited the whole fleet).
      let waited = 0;
      for (;;) {
        if (this.stopping) return;
        const blocked = this.d.parks.blocking(this.account.id, 'session');
        if (!blocked) break;
        if (blocked.needsOperator && !Number.isFinite(blocked.until)) {
          // Nothing will change without a human. Sit still and stay quiet.
          this.note = `waiting for operator: ${blocked.reason.slice(0, 90)}`;
          await sleep(30_000);
          continue;
        }
        await sleep(5_000);
        waited += 5_000;
        if (waited > 10 * 60_000) break; // safety valve against a stuck park
      }
      await sleep(5_000);
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
      ...(typeof this.session.character?.level === 'number'
        ? { level: this.session.character.level }
        : {}),
      duelsDisabled: true,
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

    // Town is a social hub: its `mobs` collection is always empty (verified
    // live). Staying here produces nothing, so head into a dungeon.
    await this.runDungeon();

    let ticks = 0;
    while (!this.stopping && !left && zone.connected) {
      await this.tick();
      await this.tempo();
      if (++ticks % 60 === 0) await this.sellCycle();
    }

    await zone.leave(true);
    this.zone = null;
  }

  /**
   * Enter a solo dungeon and play it out.
   *
   * Routed through free() so a denied entry parks instead of looping, and so a
   * fleet-wide park stops every wallet from queueing for runs at once.
   */
  private async runDungeon(): Promise<void> {
    if (!this.session) return;

    // Entry is refused with `too_far` unless the hero is on the trapdoor, so
    // walk there first rather than requesting from the spawn point.
    const at = await this.walkToDungeonEntrance();
    const self = readSelf(this.latestState, this.zone?.sessionId ?? null);
    const atCol = at?.col ?? self.pos?.x ?? 0;
    const atRow = at?.row ?? self.pos?.y ?? 0;

    await free(this.d.parks, this.account.id, 'dungeon', async () => {
      let entry;
      try {
        entry = await enterSoloDungeon({
          endpoint: zoneEndpoint(this.d.cfg.RELIC_BASE_URL),
          token: this.session!.token,
          atCol,
          atRow,
          startDepth: 1,
        });
      } catch (err) {
        if (err instanceof EntryDeniedError) {
          // A denial is data, not a crash: record why and let the park decide.
          this.note = `dungeon entry denied: ${err.reason}`;
          this.log.warn(this.note);
          throw new Error(`dungeon_denied_${err.reason}`);
        }
        throw err;
      }

      const { room, client } = entry;
      this.note = 'in dungeon';
      let finished = false;

      for (const type of VALUE_SIGNALS) {
        room.onMessage(type, (payload: unknown) => {
          this.d.ledger.append({
            accountId: this.account.id,
            kind: type === DUNGEON_IN.FLOOR_CLEARED ? 'kill' : 'loot',
            detail: safeLabel(payload) ?? type,
          });
        });
      }
      room.onMessage(DUNGEON_IN.EXIT, () => {
        finished = true;
      });
      room.onMessage(DUNGEON_IN.SUMMARY, (p: unknown) => {
        this.log.info(`run summary: ${JSON.stringify(p).slice(0, 200)}`);
        finished = true;
      });
      room.onStateChange((st) => {
        this.latestState = st;
      });
      room.onLeave(() => {
        finished = true;
      });

      const started = Date.now();
      while (!this.stopping && !finished && Date.now() - started < 20 * 60_000) {
        await this.dungeonTick(room);
        await this.tempo();
      }

      await room.leave(true).catch(() => {});
      void client;
      this.note = 'dungeon run ended';
    });
  }

  /**
   * Walk to the town's dungeon entrance.
   *
   * Returns the cell actually reached, or null if the map or a route could not
   * be found — in which case entry is still attempted from where we stand, so a
   * map-loading failure degrades rather than blocks.
   */
  private async walkToDungeonEntrance(): Promise<Cell | null> {
    const zone = this.zone;
    if (!zone?.connected) return null;

    const map = await loadWorldMap(this.d.cfg.RELIC_BASE_URL, 'town');
    if (!map) return null;

    const target = dungeonEntrance(map);
    if (!target) {
      this.log.warn('town map has no dungeonEntrance marker');
      return null;
    }

    const self = readSelf(this.latestState, zone.sessionId);
    if (!self.pos) {
      // Position unknown: ask to move straight to the trapdoor and hope the
      // server pathfinds. Worst case it refuses and we report `too_far`.
      zone.send(MSG.MOVE, { col: target.col, row: target.row, seq: ++this.moveSeq });
      await sleep(3_000);
      return target;
    }

    const from: Cell = { col: Math.round(self.pos.x), row: Math.round(self.pos.y) };
    const path = findPath(map, from, target);
    if (!path) {
      this.log.warn(`no route from (${from.col},${from.row}) to the dungeon entrance`);
      return null;
    }

    this.note = `walking to the dungeon entrance (${path.length} steps)`;
    for (const step of path) {
      if (this.stopping || !zone.connected) break;
      zone.send(MSG.MOVE, { col: step.col, row: step.row, seq: ++this.moveSeq });
      // Roughly the client's own step cadence; moving faster invites a desync.
      await sleep(220);
    }
    await sleep(1_200);
    return target;
  }

  /** One decision inside a dungeon, where the mobs actually are. */
  private async dungeonTick(room: { send: (t: string, p?: unknown) => void }): Promise<void> {
    const entities = readEntities(this.latestState);
    const self = readSelf(this.latestState, null);

    const loot = lootCandidates(self, entities);
    if (loot.length > 0) {
      const d = await this.d.otak.decide({
        domain: 'economy',
        situation: `${loot.length} drop(s) in reach`,
        candidates: loot,
      });
      const parsed = d.chosenId ? parseCandidateId(d.chosenId) : null;
      if (parsed) {
        room.send(MSG.LOOT_PICKUP, { dropId: parsed.target });
        return;
      }
    }

    const targets = combatCandidates(
      self,
      entities,
      this.d.combat,
      this.account.id,
      DEFAULT_COMBAT_TUNING,
    );
    if (targets.length === 0) {
      this.note = 'dungeon: nothing engageable';
      return;
    }

    const d = await this.d.otak.decide({
      domain: 'combat',
      situation: `hp=${self.hp ?? '?'}/${self.maxHp ?? '?'}, ${targets.length} in reach`,
      candidates: targets,
    });
    const parsed = d.chosenId ? parseCandidateId(d.chosenId) : null;
    if (!parsed) {
      this.note = `otak declined: ${d.reasoning}`;
      return;
    }
    this.note = `attacking ${parsed.target} (${d.source})`;
    room.send(MSG.ATTACK, {
      targetId: parsed.target,
      fromCol: self.pos ? Math.round(self.pos.x) : undefined,
      fromRow: self.pos ? Math.round(self.pos.y) : undefined,
    });
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
        zone.send(MSG.LOOT_PICKUP, { dropId: parsed.target });
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
      zone.send(MSG.ATTACK, {
        targetId: parsed.target,
        fromCol: self.pos ? Math.round(self.pos.x) : undefined,
        fromRow: self.pos ? Math.round(self.pos.y) : undefined,
      });
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
