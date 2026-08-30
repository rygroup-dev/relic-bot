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
import { SignalState, SIG, VALUE_SIGNALS as SIGNAL_VALUE } from '../net/signals.js';
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
import {
  readEntities,
  readSelf,
  describeUnknownState,
  type SelfView,
  type EntityView,
} from '../game/state.js';
import {
  characterIntents,
  intentsToCandidates,
  type ActionIntent,
  type InventoryItem,
} from '../game/actions.js';
import { loadWorldMap, dungeonEntrance, findPath, type Cell } from '../game/world.js';
import { logger, type Logger } from '../log.js';
import type { Config } from '../config.js';

/**
 * Below this fraction of max HP the bot stops trading hits and tries to
 * survive instead. A wipe forfeits the entire run's loot, so the expected cost
 * of one more kill attempt is much higher than it looks.
 */
export const CRITICAL_HP_FRACTION = 0.35;

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
  /** Raised for things worth interrupting a person for. */
  alert?: (kind: 'level_up' | 'rare_drop' | 'gate_opened', text: string, accountId: string) => void;
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
  /** Everything the s.* signal stream tells us — inventory, gold, cooldowns. */
  private signals = new SignalState();
  /** Session id of the dungeon room, known only once the join completes. */
  private dungeonSessionId: string | null = null;
  private dungeonDumped = false;
  /**
   * Dungeon room state, kept separate from the town's.
   *
   * The town connection stays open during a run and keeps pushing its own
   * state. Sharing one field meant town state overwrote dungeon state between
   * ticks, so the bot read town's 6 idle players and empty `mobs` collection
   * and concluded there was nothing to fight — inside a dungeon full of mobs.
   */
  private dungeonState: unknown = null;
  /** Set by `d.cleared`; the exit only opens once the floor is done. */
  private floorCleared = false;
  /** Set by `d.fountain.state` when a healing fountain is available. */
  private fountainReady = false;
  /** Cell the fountain must be used from, from the same payload. */
  private fountainAt: Cell | null = null;
  /** Set by `d.resurrection.state`. */
  private resurrectionReady = false;
  /** Cell the resurrection shrine must be used from. */
  private resurrectionAt: Cell | null = null;
  private descendSentAt = 0;
  /** Last level seen, so a level-up is detected rather than polled. */
  private lastLevel: number | null = null;
  /** Gate state at the previous check, to notice it opening. */
  private lastGateAllowed: boolean | null = null;
  /**
   * Display name of the mob most recently attacked.
   *
   * The server sends no "X killed you" payload, so this is the only evidence
   * available for attributing a death. Without it every death went unrecorded
   * and `winRate()` returned a perfect 1.0 for every monster in the game.
   */
  private lastTargetName: string | null = null;
  /**
   * Distinct dungeon message types seen this run, logged once each at debug.
   *
   * Added because `inventory sync` appeared ZERO times in the entire journal:
   * either `s.inv.sync` never arrives or its payload shape differs from the
   * three keys probed. Without the inventory every potion, equip and sell
   * decision is dead code, so the actual vocabulary has to be observed rather
   * than assumed.
   */
  private seenTypes = new Set<string>();
  /**
   * Last readable-state verdict, so a flip is logged instead of every tick.
   *
   * `null` means "not yet decided", which is distinct from `false` — the first
   * verdict of a run must always be logged, whatever it is.
   */
  private lastReadable: boolean | null = null;

  /**
   * Every message from the dungeon room.
   *
   * Attached at join time rather than after, because the server's opening
   * burst of state arrives immediately and `s.inv.sync` is sent only once.
   */
  private onDungeonSignal(type: string, payload: unknown): void {
    this.signals.apply(type, payload, this.dungeonSessionId);

    // Observe the real vocabulary once per type. `s.inv.sync` has never once
    // been logged as received, and an unread inventory silently disables
    // potions, equipping and selling — so the shape gets dumped rather than
    // assumed. Debug-level: this is diagnosis, not routine output.
    if (!this.seenTypes.has(type)) {
      this.seenTypes.add(type);
      this.log.debug(`first ${type}: ${safeShape(payload)}`);
    }

    // A mythic or legendary drop is worth telling someone about; commons are
    // constant noise and must never reach the chat.
    if (type === DUNGEON_IN.DROP_SPAWN || type === DUNGEON_IN.BOSS_LOOT) {
      const r = payload as { rarity?: unknown; name?: unknown } | null;
      const rarity = typeof r?.rarity === 'string' ? r.rarity.toLowerCase() : null;
      if (rarity === 'mythic' || rarity === 'legendary' || rarity === 'cosmetic') {
        const name = typeof r?.name === 'string' ? r.name : 'an item';
        this.d.alert?.('rare_drop', `${rarity} drop: ${name}`, this.account.id);
      }
    }

    if (SIGNAL_VALUE.includes(type)) {
      this.d.ledger.append({
        accountId: this.account.id,
        kind: type === SIG.LOOT_GOLD ? 'gold' : 'loot',
        detail: type,
      });
    }

    // Dungeon progression signals. Without these the bot never leaves floor 1
    // and never uses the two things that keep a run alive.
    if (type === DUNGEON_IN.FLOOR_CLEARED) {
      this.floorCleared = true;
      this.note = 'floor cleared';
    } else if (type === DUNGEON_IN.FOUNTAIN_STATE) {
      this.fountainReady = readyFlag(payload);
      // The payload carries the cell the prop must be used from. Without it the
      // bot sent i.dungeon.fountain.use from wherever it stood; the server
      // refuses that silently, so a critical-HP tick was spent on nothing.
      this.fountainAt = readInteractionCell(payload);
    } else if (type === DUNGEON_IN.RESURRECTION_STATE) {
      this.resurrectionReady = readyFlag(payload);
      this.resurrectionAt = readInteractionCell(payload);
    } else if (type === DUNGEON_IN.DESCEND) {
      // A successful descend resets the floor: new mobs, new exit.
      this.floorCleared = false;
      this.descendSentAt = 0;
      this.log.info('descended to the next floor');
    } else if (type === DUNGEON_IN.DESCEND_DENIED) {
      const reason = String((payload as { reason?: unknown } | null)?.reason ?? 'unknown');
      this.descendSentAt = 0;
      if (reason === 'not_cleared') this.floorCleared = false;
      this.log.debug(`descend denied: ${reason}`);
    }

    if (type === SIG.DEATH) {
      if (this.signals.dead) {
        this.note = 'died in the dungeon';
        // Record the loss. `record()` accepts 'win' | 'loss' but 'loss' was
        // never once passed anywhere in src/, so every wallet reported
        // wins === battles and winRate() returned a flat 1.0. That fed
        // combatCandidates(), whose loseAversion term is therefore inert: the
        // bot re-picked the monster that had just killed it, every run.
        // Evidence for the misread: 328 run summaries, all reason="wiped",
        // all depthReached=1, against zero recorded losses.
        //
        // The server sends no killer id, so the mob we were last attacking is
        // the only attribution available. Named 'unknown' when there is none,
        // matching how kills are recorded.
        this.d.combat.record(this.account.id, this.lastTargetName ?? 'unknown', 'loss');
        // Deliberately NOT written to the value ledger: `lastValueAt()` is the
        // watchdog's only liveness signal, so logging a death there would make
        // dying look like production and silence the one alarm that works.
        this.lastTargetName = null;
      } else {
        // A death that is not ours is a kill — the only kill evidence there is.
        // The death payload carries an id but not always a name, so resolve it
        // against the mob still in state: per-monster win rates are what drive
        // target selection, and "unknown" makes that memory useless.
        const id = (payload as { id?: unknown } | null)?.id;
        const named = typeof id === 'string' ? this.mobName(id) : null;
        for (const monster of this.signals.drainKills()) {
          this.d.combat.record(this.account.id, named ?? monster, 'win');
        }
      }
    }
  }

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
    const s = readSelf(this.dungeonState ?? this.latestState, this.dungeonSessionId ?? this.zone?.sessionId ?? null);

    // A level-up is real progress and rare enough to be worth a message.
    if (s.level !== null) {
      if (this.lastLevel !== null && s.level > this.lastLevel) {
        this.d.alert?.('level_up', `reached level ${s.level}`, this.account.id);
      }
      this.lastLevel = s.level;
    }
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
        const msg = (err as Error).message;
        this.log.warn(`cycle ended: ${msg}`);

        // Only throw the token away when the server actually rejected it.
        // A dropped socket or a refused dungeon entry says nothing about
        // whether we are still authenticated.
        if (/401|403|unauthor|invalid.?token|expired/i.test(msg)) {
          this.log.info('session rejected — will re-authenticate');
          this.session = null;
        }
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

  /**
   * A JWT is valid for days; a room connection is not.
   *
   * Re-authenticating every time the town socket drops was burning the shared
   * auth gate — 13 of 13 parks in a 30-minute run were `rate_limited` on login,
   * and the limiter widened to its 180s ceiling. Reusing a token we already
   * hold costs nothing and is what the real client does.
   */
  private async ensureSession(): Promise<Session> {
    if (this.session) return this.session;
    this.phase = 'authenticating';
    this.session = await this.d.auth.login(this.account);
    return this.session;
  }

  private async sessionCycle(): Promise<void> {
    const session = await this.ensureSession();

    this.gateStatus = await this.d.gate.check(
      this.account.id,
      session.token,
      this.account.address,
    );
    if (!this.gateStatus.allowed) {
      this.note = 'token gate CLOSED - market features unavailable, still farming';
      this.log.warn(this.note);
    } else if (this.lastGateAllowed === false) {
      // The wallet crossed the holding requirement: selling just became
      // possible, which changes what this wallet is for.
      this.d.alert?.('gate_opened', 'token gate is now OPEN — selling unlocked', this.account.id);
    }
    this.lastGateAllowed = this.gateStatus.allowed;

    this.phase = 'connecting';
    const zone = new ZoneConnection({
      endpoint: zoneEndpoint(this.d.cfg.RELIC_BASE_URL),
      room: ROOM.TOWN,
      token: session.token,
      ...(session.character?.name ? { name: session.character.name } : {}),
      ...(session.character?.classId ? { classId: session.character.classId } : {}),
      ...(typeof session.character?.level === 'number'
        ? { level: session.character.level }
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
    // live). Everything of value is in dungeons, so the session is a loop of
    // runs — not one run followed by standing in the square.
    //
    // This was the cause of a 45-minute production freeze: a single run was
    // made, then the loop fell through to the town tick, where there is
    // nothing to fight and nothing to pick up. Zero errors, zero output.
    let runs = 0;
    while (!this.stopping && !left && zone.connected) {
      await this.runDungeon();
      runs += 1;

      if (this.stopping || left || !zone.connected) break;

      // Between runs: sell what the last one produced, then go again.
      await this.sellCycle();
      this.note = `between runs (${runs} completed)`;

      // A short breather so a failed entry does not become a hot loop.
      await sleep(5_000);
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

    // Check the park BEFORE walking. free() below would refuse a parked entry
    // anyway, but the walk is 19 server-acked moves and it happens first, so a
    // parked wallet would still cross town every 5s to be turned away at the
    // door. Observed live 2026-08-30 as the movement half of the high_demand
    // storm.
    const parked = this.d.parks.blocking(this.account.id, 'dungeon');
    if (parked) {
      const waitMs = Number.isFinite(parked.until)
        ? Math.max(5_000, parked.until - Date.now())
        : 60_000;
      this.note = `waiting out ${parked.key} park: ${parked.reason.slice(0, 60)}`;
      await sleep(Math.min(waitMs, 180_000));
      return;
    }

    // Entry is refused with `too_far` unless the hero is on the trapdoor, so
    // walk there first rather than requesting from the spawn point.
    const at = await this.walkToDungeonEntrance();
    const self = readSelf(this.latestState, this.zone?.sessionId ?? null);
    const atCol = at?.col ?? self.pos?.x ?? 0;
    const atRow = at?.row ?? self.pos?.y ?? 0;

    await free(this.d.parks, this.account.id, 'dungeon', async () => {
      let entry;
      // Cleared before the join so the opening burst is never attributed to a
      // previous run's session id.
      this.dungeonSessionId = null;
      try {
        entry = await enterSoloDungeon({
          endpoint: zoneEndpoint(this.d.cfg.RELIC_BASE_URL),
          token: this.session!.token,
          atCol,
          atRow,
          startDepth: 1,
          // Registered inside the join so the server's initial state burst —
          // s.inv.sync in particular, which is sent exactly once — is not lost
          // in the gap between the join resolving and a handler being added.
          onMessage: (type, payload) => this.onDungeonSignal(type, payload),
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
      const joinedAt = Date.now();
      this.signals.resetRun();
      this.lastTargetName = null;
      this.seenTypes.clear();
      this.lastReadable = null;
      let finished = false;

      this.dungeonSessionId = room.sessionId;
      this.dungeonDumped = false;
      this.dungeonState = null;
      this.floorCleared = false;
      this.fountainReady = false;
      this.fountainAt = null;
      this.resurrectionReady = false;
      this.resurrectionAt = null;
      this.descendSentAt = 0;

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
        this.log.info('run ended: d.exit');
        finished = true;
      });
      room.onMessage(DUNGEON_IN.SUMMARY, (p: unknown) => {
        this.log.info(`run summary: ${JSON.stringify(p).slice(0, 200)}`);
        finished = true;
      });
      room.onStateChange((st) => {
        this.dungeonState = st;
        if (!this.dungeonDumped) {
          this.dungeonDumped = true;
          // One-time shape dump. The dungeon state is a different schema from
          // town, and guessing at it is how the distance filter silently
          // excluded every target.
          this.log.debug(`dungeon state shape:\n${describeUnknownState(st, 3, 40)}`);
        }
      });
      // Why the room closed. Runs were observed ending ~2s after joining with no
      // d.exit and no d.summary, which means this fired — but it logged nothing,
      // so a 2-second run was indistinguishable from a completed one. The code
      // is the whole diagnosis: 1000 is a normal close, 4xxx is a server refusal.
      room.onLeave((code: number) => {
        const alive = Math.round((Date.now() - joinedAt) / 100) / 10;
        this.log.warn(`run ended: room closed (code ${code}) after ${alive}s`);
        finished = true;
      });

      const started = Date.now();
      let diedAt = 0;
      let lastProgress = Date.now();
      let lastLedger = this.d.ledger.lastValueAt(this.account.id);

      while (!this.stopping && !finished && Date.now() - started < 20 * 60_000) {
        await this.dungeonTick(room, room.sessionId);
        await this.tempo();

        // Death used to leave the loop spinning for the full 20 minutes waiting
        // for a summary that may never arrive — the wallet produced nothing and
        // reported no error, which is exactly the failure mode the watchdog
        // exists to catch. Give the server a moment to send the summary, then go.
        if (this.signals.dead) {
          if (diedAt === 0) diedAt = Date.now();
          if (Date.now() - diedAt > 15_000) {
            this.log.info('died — leaving the run rather than idling');
            break;
          }
          continue;
        }

        // A run that produces nothing for minutes is stuck, not unlucky.
        const now = this.d.ledger.lastValueAt(this.account.id);
        if (now > lastLedger) {
          lastLedger = now;
          lastProgress = Date.now();
        } else if (Date.now() - lastProgress > 5 * 60_000) {
          this.log.warn('no value for 5m inside the run — abandoning it');
          break;
        }
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

    // Room state arrives asynchronously after joinOrCreate resolves. Walking
    // before it lands means walking from an unknown position, which is how the
    // first attempt ended up requesting entry from the spawn point and being
    // refused with `too_far`.
    const self = await this.awaitPosition(zone, 12_000);
    if (!self?.pos) {
      this.log.warn('no position after 12s of room state — cannot walk to the trapdoor');
      return null;
    }

    const from: Cell = { col: Math.round(self.pos.x), row: Math.round(self.pos.y) };
    this.log.info(`at (${from.col},${from.row}), trapdoor at (${target.col},${target.row})`);
    const path = findPath(map, from, target);
    if (!path) {
      this.log.warn(`no route from (${from.col},${from.row}) to the dungeon entrance`);
      return null;
    }

    this.note = `walking to the dungeon entrance (${path.length} steps)`;
    this.log.info(`walking ${path.length} steps to the dungeon entrance`);
    for (const step of path) {
      if (this.stopping || !zone.connected) break;
      zone.send(MSG.MOVE, { col: step.col, row: step.row, seq: ++this.moveSeq });
      // Roughly the client's own step cadence; moving faster invites a desync.
      await sleep(220);
    }

    // Let the server settle our final position before asking to descend.
    await sleep(1_500);
    const arrived = readSelf(this.latestState, zone.sessionId);
    if (arrived.pos) {
      const dist = Math.hypot(arrived.pos.x - target.col, arrived.pos.y - target.row);
      this.log.info(
        `arrived at (${Math.round(arrived.pos.x)},${Math.round(arrived.pos.y)}), ` +
          `${dist.toFixed(1)} cells from the trapdoor`,
      );
    }
    return target;
  }

  /**
   * Wait for the room to tell us where we are.
   *
   * Colyseus delivers state after the join promise resolves, so anything that
   * depends on position has to wait for it rather than assume it is there.
   */
  private async awaitPosition(zone: ZoneConnection, timeoutMs: number): Promise<SelfView | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.stopping || !zone.connected) return null;
      const self = readSelf(this.latestState, zone.sessionId);
      if (self.pos) return self;
      await sleep(400);
    }
    return null;
  }

  /**
   * Non-combat upkeep: potions, abilities, equipment, attributes, chests.
   *
   * Runs before combat every tick and works with the LLM off — Otak only
   * reorders the intents the heuristics already produced.
   */
  private async upkeep(
    send: (t: string, p?: unknown) => void,
    self: SelfView,
    entities: readonly ReturnType<typeof readEntities>[number][],
    targetId: string | null,
  ): Promise<boolean> {
    const intents = characterIntents(self, this.inventory(), entities, {
      classId: (this.session?.character?.classId as never) ?? null,
      targetId,
      abilities: this.abilities(),
      unspentPoints: this.unspentPoints(),
      // The level from the state read can be null before the dungeon schema
      // lands, and equipIntent() skips every item whose levelReq it cannot
      // clear — so a null level meant nothing was ever equipped. The signal
      // stream carries an authoritative level on every kill.
      level: this.heroLevel(self),
    });
    if (intents.length === 0) return false;

    const outcome = await free(this.d.parks, this.account.id, 'upkeep', async () => {
      const decision = await this.d.otak.decide({
        domain: 'progression',
        situation: `hp=${self.hp ?? '?'}/${self.maxHp ?? '?'} mana=${self.mana ?? '?'}/${self.maxMana ?? '?'}`,
        candidates: intentsToCandidates(intents),
      });
      const idx = decision.chosenId ? Number(decision.chosenId.split(':')[1]) : 0;
      const chosen: ActionIntent | undefined = intents[Number.isFinite(idx) ? idx : 0];
      if (!chosen) return false;
      this.note = chosen.label;
      // Logged because these are the actions that make a hero stronger, and
      // until 2026-08-30 not one of them had ever fired: the inventory parser
      // matched nothing, so potions, equips and attribute spends were all
      // silently unreachable. An empty log here is the alarm.
      this.log.info(`upkeep: ${chosen.label} (${chosen.reason})`);
      send(chosen.type, chosen.payload);
      return true;
    });
    return outcome.ran && outcome.value === true;
  }

  /** Resolve a mob id to its display name using the last dungeon state. */
  private mobName(id: string): string | null {
    for (const e of readEntities(this.dungeonState)) {
      if (e.kind === 'monster' && e.id === id && e.name && e.name !== 'mobs') return e.name;
    }
    return null;
  }

  /**
   * Send one cardinal step from `here` toward `to`. Returns false when already
   * there.
   *
   * Cardinal-only, and the reason is load-bearing: a diagonal `i.move` is
   * refused by the server every time, which is what pinned the hero at its
   * spawn cell and stopped it ever attacking. Shared by mob approach and prop
   * approach so the rule cannot be re-broken in one of them.
   */
  private stepToward(
    room: { send: (t: string, p?: unknown) => void },
    here: Cell,
    to: Cell,
  ): boolean {
    const dCol = to.col - here.col;
    const dRow = to.row - here.row;
    if (dCol === 0 && dRow === 0) return false;
    const step =
      Math.abs(dCol) >= Math.abs(dRow)
        ? { col: here.col + Math.sign(dCol), row: here.row }
        : { col: here.col, row: here.row + Math.sign(dRow) };
    room.send(MSG.MOVE, { col: step.col, row: step.row, seq: ++this.moveSeq });
    return true;
  }

  /**
   * Step toward the nearest living mob.
   *
   * Moves in a straight line rather than pathfinding: the dungeon is
   * procedural and no collision map is published for it, so a BFS would be
   * guessing at walls. The server refuses illegal moves and reports where we
   * really are via `s.move.denied`, which is better truth than a map we do
   * not have.
   *
   * ONE AXIS PER STEP. This sent `{ col: col+dx, row: row+dy }` with both
   * deltas non-zero — a diagonal — and the server refused every single one:
   * 14 `s.move.denied` against 0 `s.path` in a 10-minute window, with the hero
   * pinned at its spawn cell and the resync echoing that same cell back. The
   * town pathfinder in `world.ts` only ever emits cardinal neighbours
   * ([1,0] [-1,0] [0,1] [0,-1]) and walking to the trapdoor always worked, so
   * cardinal-only is the movement rule the server enforces.
   *
   * Consequence of the diagonal: distance stuck at 12 cells against a
   * `maxEngageDistance` of 12, so `combatCandidates()` was always empty and the
   * bot never attacked once — in a room with 66 mobs.
   */
  private approachNearestMob(
    room: { send: (t: string, p?: unknown) => void },
    self: SelfView,
    entities: readonly EntityView[],
  ): boolean {
    if (!self.pos) return false;

    const alive = entities.filter(
      (e) => e.kind === 'monster' && e.pos && (e.hp === null || e.hp > 0),
    );
    if (alive.length === 0) return false;

    const me = self.pos;
    const dist = (e: EntityView): number => Math.hypot(e.pos!.x - me.x, e.pos!.y - me.y);
    const nearest = alive.reduce((a, b) => (dist(b) < dist(a) ? b : a));

    // A server-supplied resync always wins over our own dead reckoning.
    const resync = this.signals.takeResync();
    const from = resync ?? { col: Math.round(me.x), row: Math.round(me.y) };

    const target = nearest.pos!;
    const dCol = target.x - from.col;
    const dRow = target.y - from.row;
    if (!this.stepToward(room, from, { col: Math.round(target.x), row: Math.round(target.y) })) {
      return false;
    }
    // Position is part of the note on purpose. The note is only logged when it
    // CHANGES, so including the origin cell makes a stalled approach visible: a
    // bot that is actually closing distance logs a new line each step, while one
    // that is refused every tick logs exactly once and then goes quiet.
    this.note =
      `approaching ${nearest.name} from (${from.col},${from.row})` +
      `${resync ? ' [resynced]' : ''} — ` +
      `${Math.round(Math.hypot(dCol, dRow))} cells away`;
    return true;
  }


  /**
   * Inventory, from the `s.inv.sync` signal.
   *
   * It is NOT in the room state — reading it from there always came back
   * empty, which silently disabled every potion and equip decision.
   */
  private inventory(): InventoryItem[] {
    return this.signals.inventory.map((e) => {
      const item: InventoryItem = { name: e.name };
      if (e.instanceId) item.instanceId = e.instanceId;
      if (e.itemId) item.itemId = e.itemId;
      if (e.slot) item.slot = e.slot;
      if (e.rarity) item.rarity = e.rarity;
      if (e.quantity !== undefined) item.quantity = e.quantity;
      if (e.equipped !== undefined) item.equipped = e.equipped;
      if (e.consumable !== undefined) item.consumable = e.consumable;
      if (e.ilvl !== undefined) item.ilvl = e.ilvl;
      if (e.levelReq !== undefined) item.levelReq = e.levelReq;
      if (e.classId !== undefined) item.classId = e.classId;
      // The server does not label what a potion restores, so infer from the
      // name rather than inventing a field that is not there.
      if (item.consumable) {
        item.restores = /mana|spirit|ether/i.test(e.name)
          ? 'mana'
          : /health|heal|life|hp/i.test(e.name)
            ? 'hp'
            : null;
      }
      return item;
    });
  }

  /**
   * Abilities exposed on the player record, if any.
   *
   * KNOWN GAP, stated rather than guessed: the live dungeon player schema
   * (dumped 2026-08-30) carries NO abilities or spells array. Its 44 fields are
   * position, six shield pools, hp/mana, level/xp/gold/pxp, kills/deaths, the
   * five alloc* attributes, bonusAttrPoints, and dead/ghost/corpse state.
   *
   * So this returns [] on the live server and `castIntent()` is never offered —
   * the bot attacks with `i.attack` only. The loadout is likely delivered by
   * `s.loadout.locked`, which is in SIG but not yet captured. Reading the
   * dungeon record rather than town's is still correct: when the source is
   * found this is where it will surface.
   */
  private abilities(): { abilityId: string; name?: string; manaCost?: number; readyAt?: number }[] {
    const self = readSelf(
      this.dungeonState ?? this.latestState,
      this.dungeonSessionId ?? this.zone?.sessionId ?? null,
    );
    const raw = self.raw as Record<string, unknown> | null;
    const list = raw?.abilities ?? raw?.spells;
    if (!Array.isArray(list)) return [];
    return list
      .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object')
      .map((a) => {
        const out: { abilityId: string; name?: string; manaCost?: number; readyAt?: number } = {
          abilityId: String(a.abilityId ?? a.id ?? ''),
        };
        if (typeof a.name === 'string') out.name = a.name;
        if (typeof a.manaCost === 'number') out.manaCost = a.manaCost;
        // Prefer the cooldown the server actually told us about.
        const observed = this.signals.cooldownReadyAt(out.abilityId);
        if (observed !== undefined) out.readyAt = observed;
        else if (typeof a.readyAt === 'number') out.readyAt = a.readyAt;
        return out;
      })
      .filter((a) => a.abilityId.length > 0);
  }

  /**
   * Unallocated attribute points.
   *
   * Two bugs lived here, both silent. The field is `bonusAttrPoints`, not
   * `unspentPoints` — the latter appears nowhere in the schema, so this always
   * returned 0 and `attributeIntent()` was never once offered. And it read
   * `latestState` (town) with the town session id while the caller is inside a
   * dungeon, where both differ. Verified against a live dungeon state dump
   * 2026-08-30.
   */
  private unspentPoints(): number {
    const self = readSelf(
      this.dungeonState ?? this.latestState,
      this.dungeonSessionId ?? this.zone?.sessionId ?? null,
    );
    return self.bonusAttrPoints !== null && self.bonusAttrPoints > 0
      ? Math.floor(self.bonusAttrPoints)
      : 0;
  }

  /**
   * Level from whichever source actually has it.
   *
   * The signal stream is preferred: `s.combat.xp` carries an authoritative
   * `level` on every kill, whereas the room-state read depends on the dungeon
   * schema having landed. Used for the equip level-requirement check, which
   * silently skipped every item while the level read as null.
   */
  private heroLevel(self: SelfView): number | null {
    return this.signals.level ?? self.level ?? this.session?.character?.level ?? null;
  }

  /** One decision inside a dungeon, where the mobs actually are. */
  private async dungeonTick(
    room: { send: (t: string, p?: unknown) => void },
    sessionId: string | null,
  ): Promise<void> {
    // `note` is the only record of what a tick decided, and it was written to a
    // status field that never reaches the log — so "is the bot attacking?" was
    // unanswerable from the journal, and counting `attacking` in it proved
    // nothing either way. Log the note whenever it CHANGES: every branch below
    // already sets one, so this covers the whole decision surface at a few
    // lines per run rather than one per tick.
    const before = this.note;
    try {
      await this.decideInDungeon(room, sessionId);
    } finally {
      if (this.note !== before) this.log.info(`tick: ${this.note}`);
    }
  }

  private async decideInDungeon(
    room: { send: (t: string, p?: unknown) => void },
    sessionId: string | null,
  ): Promise<void> {
    // Dead, but the floor may offer a way back. Both are free to try and both
    // are refused harmlessly if unavailable, which beats ending a run that
    // still has loot in it.
    if (this.signals.dead) {
      if (this.resurrectionReady) {
        // Same interaction-cell rule as the fountain: a shrine used from the
        // wrong cell is refused in silence. A dead hero cannot walk, so this is
        // attempted only when already in reach, and revive is the fallback.
        const at = this.resurrectionAt;
        const self = readSelf(this.dungeonState, sessionId);
        const here = self.pos ? { col: Math.round(self.pos.x), row: Math.round(self.pos.y) } : null;
        const inReach =
          !at || (here && Math.abs(at.col - here.col) <= 1 && Math.abs(at.row - here.row) <= 1);
        if (inReach) {
          this.note = 'dead — using the resurrection';
          room.send(MSG.DUNGEON_RESURRECTION_USE, {});
          this.resurrectionReady = false;
          return;
        }
      }
      this.note = 'dead — attempting revive';
      room.send(MSG.REVIVE, {});
      return;
    }

    const entities = readEntities(this.dungeonState);
    // The dungeon room has its own session id AND its own state. Reading the
    // shared field gave town's view; reading with a null id gave nothing.
    const self = readSelf(this.dungeonState, sessionId);

    // Why a tick did nothing, once per run. Added because a fleet can sit in a
    // dungeon producing no attacks and no upkeep at all, with zero errors — the
    // exact failure mode the watchdog exists for, and unreadable without this.
    //
    // Re-logged whenever the readable-state verdict FLIPS, not just on tick 0:
    // the first tick fires before Colyseus has delivered the opening state, so a
    // tick-0-only dump always reads "entities=0" and says nothing about whether
    // the bot ever recovered.
    const mobCount = entities.filter((e) => e.kind === 'monster').length;
    const readable = self.pos !== null && mobCount > 0;
    if (this.lastReadable !== readable) {
      this.lastReadable = readable;
      this.log.info(
        `state ${readable ? 'READABLE' : 'BLIND'}: ` +
          `self=(${self.pos ? `${self.pos.x},${self.pos.y}` : '?'}) ` +
          `hp=${self.hp ?? '?'}/${self.maxHp ?? '?'} lvl=${self.level ?? '?'} ` +
          `attrPts=${self.bonusAttrPoints ?? '?'} entities=${entities.length} ` +
          `mobs=${mobCount} bag=${this.inventory().length} ` +
          `sid=${sessionId ?? 'null'} stateKeys=${
            this.dungeonState && typeof this.dungeonState === 'object'
              ? Object.keys(this.dungeonState as object).join('|')
              : 'none'
          }`,
      );
    }

    // An incoming attack telegraph is the one moment where moving beats
    // attacking. Roll first, ask questions after.
    if (this.signals.underTelegraph()) {
      this.note = 'dodging a telegraphed attack';
      room.send(MSG.ROLL, {});
      return;
    }

    // Survival gate. Fighting on at low HP with nothing to drink is how a run
    // ends in `wiped` — and a wipe forfeits the whole run's loot, which costs
    // far more than the kills it would have bought.
    const hpFrac =
      self.hp !== null && self.maxHp !== null && self.maxHp > 0 ? self.hp / self.maxHp : null;

    if (hpFrac !== null && hpFrac <= CRITICAL_HP_FRACTION) {
      // A fountain is free healing, but it can only be used from its own
      // interaction cell — the server refuses it silently from anywhere else,
      // which turned a critical-HP tick into a no-op. Walk there first.
      if (this.fountainReady) {
        const at = this.fountainAt;
        const here = self.pos ? { col: Math.round(self.pos.x), row: Math.round(self.pos.y) } : null;
        const adjacent =
          at && here && Math.abs(at.col - here.col) <= 1 && Math.abs(at.row - here.row) <= 1;
        if (!at || adjacent) {
          this.note = `critical ${Math.round(hpFrac * 100)}% hp — drinking from the fountain`;
          room.send(MSG.DUNGEON_FOUNTAIN_USE, {});
          this.fountainReady = false;
          return;
        }
        if (here && this.stepToward(room, here, at)) {
          this.note =
            `critical ${Math.round(hpFrac * 100)}% hp — walking to the fountain ` +
            `at (${at.col},${at.row})`;
          return;
        }
      }

      const potion = this.inventory().find(
        (i) => i.consumable && i.restores === 'hp' && (i.quantity ?? 1) > 0 && i.itemId,
      );
      if (potion?.itemId) {
        this.note = `critical ${Math.round(hpFrac * 100)}% hp — drinking ${potion.name}`;
        room.send(MSG.USE, { itemId: potion.itemId });
        return;
      }

      // Nothing to drink: back away from the nearest threat instead of trading
      // hits we cannot win.
      //
      // Must be the NEAREST threat, not the first in iteration order. `find()`
      // returned whatever the schema happened to list first — with 56 mobs on a
      // floor that is effectively arbitrary, so the retreat vector was computed
      // against a mob across the room and could step the hero straight into the
      // one actually hitting it.
      const threats = entities.filter(
        (e) => e.kind === 'monster' && e.pos && (e.hp === null || e.hp > 0),
      );
      const me = self.pos;
      const threat =
        me && threats.length > 0
          ? threats.reduce((a, b) =>
              Math.hypot(b.pos!.x - me.x, b.pos!.y - me.y) <
              Math.hypot(a.pos!.x - me.x, a.pos!.y - me.y)
                ? b
                : a,
            )
          : null;
      if (threat?.pos && self.pos) {
        const dx = Math.sign(self.pos.x - threat.pos.x) || 1;
        const dy = Math.sign(self.pos.y - threat.pos.y) || 1;
        this.note = `critical ${Math.round(hpFrac * 100)}% hp, no potion — retreating`;
        room.send(MSG.MOVE, {
          col: Math.round(self.pos.x + dx * 2),
          row: Math.round(self.pos.y + dy * 2),
          seq: ++this.moveSeq,
        });
        return;
      }
      this.note = `critical ${Math.round(hpFrac * 100)}% hp — holding`;
      return;
    }

    // Stay alive and geared before picking a fight.
    const target = entities.find((e) => e.kind === 'monster')?.id ?? null;
    if (await this.upkeep((t, p) => room.send(t, p), self, entities, target)) return;

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
    // A cleared floor is the whole point: deeper floors are where the better
    // loot is, and standing on a finished one produces nothing at all.
    if (this.floorCleared && Date.now() - this.descendSentAt > 15_000) {
      this.descendSentAt = Date.now();
      this.note = 'floor cleared — descending';
      room.send(MSG.DESCEND_REQ, {});
      return;
    }

    if (targets.length === 0) {
      // Nothing in reach does not mean nothing to do. A dungeon floor is much
      // larger than the engage radius, so the bot has to close the distance
      // rather than stand still waiting for mobs to wander over.
      const approached = this.approachNearestMob(room, self, entities);
      if (!approached) {
        const mobs = entities.filter((e) => e.kind === 'monster');
        this.note = `no reachable mob (${mobs.length} on the floor)`;
      }
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
    // Remembered so a death can be attributed to the mob that caused it — the
    // server sends no killer id, and without this every loss lands on 'unknown'.
    this.lastTargetName = this.mobName(parsed.target);
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

/**
 * Read a boolean-ish "is it available" flag from a state payload.
 *
 * `exhausted` is checked first and inverted. The real `d.fountain.state`
 * payload is `{ roomId, interactionCol, interactionRow, active, exhausted,
 * activeAssetId, usedAssetId }`, and `active` stays true for a fountain that
 * has already been drained — it describes the object, not its charge. Reading
 * `active` alone therefore reported a spent fountain as free healing, and the
 * bot burned its critical-HP tick on a refused use instead of retreating.
 */
function readyFlag(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const r = payload as Record<string, unknown>;
  if (typeof r.exhausted === 'boolean' && r.exhausted) return false;
  for (const k of ['available', 'ready', 'active', 'charged', 'used']) {
    const v = r[k];
    if (typeof v === 'boolean') return k === 'used' ? !v : v;
  }
  return false;
}

/** Interaction cell a dungeon prop must be stood next to before it can be used. */
function readInteractionCell(payload: unknown): Cell | null {
  if (!payload || typeof payload !== 'object') return null;
  const r = payload as Record<string, unknown>;
  const col = r.interactionCol;
  const row = r.interactionRow;
  return typeof col === 'number' && typeof row === 'number'
    ? { col: Math.round(col), row: Math.round(row) }
    : null;
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

/**
 * Top-level shape of a payload: keys and value types, never values.
 *
 * Used to learn a message's real shape without risking a secret reaching the
 * log — the redactor covers known patterns, but "log only the type names" is a
 * stronger guarantee than "match every secret format".
 */
function safeShape(payload: unknown): string {
  if (payload === null || payload === undefined) return String(payload);
  if (typeof payload !== 'object') return typeof payload;
  if (Array.isArray(payload)) {
    return `array[${payload.length}]${
      payload.length > 0 ? ` of ${safeShape(payload[0])}` : ''
    }`;
  }
  const r = payload as Record<string, unknown>;
  const parts = Object.keys(r)
    .slice(0, 24)
    .map((k) => {
      const v = r[k];
      // Recurse one level into arrays: the interesting shapes (inventory
      // instances and stacks) are the ELEMENTS, and `array[2]` alone was not
      // enough to write a parser against.
      if (Array.isArray(v)) {
        return `${k}:array[${v.length}]${v.length > 0 ? `of${safeShape(v[0])}` : ''}`;
      }
      return `${k}:${v === null ? 'null' : typeof v}`;
    });
  return `{ ${parts.join(', ')} }`;
}
