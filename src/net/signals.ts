/**
 * The `s.*` signal namespace.
 *
 * Discovered from a live dungeon run, not from the earlier bundle sweep: the
 * client registers 87 `s.*` handlers that the first pass missed entirely
 * because they are wired through `onSignal(...)` rather than named in a
 * constant map like the `l.*` and `d.*` vocabularies.
 *
 * This mattered more than it sounds. Two symptoms traced straight back to it:
 *
 *   - the ledger stayed empty while combat was obviously happening, because
 *     value arrives on `s.loot.gold` / `s.combat.xp`, not on room state
 *   - inventory reads always came back empty, because the inventory is pushed
 *     on `s.inv.sync` and never lives in the room state at all
 *
 * Payload shapes are not fully visible in the minified client, so every field
 * here is read defensively and a missing one is treated as unknown rather than
 * as zero.
 */

import { logger } from '../log.js';

const log = logger('signals');

export const SIG = {
  // movement
  PATH: 's.path',
  MOVE_DENIED: 's.move.denied',

  // value
  LOOT_GOLD: 's.loot.gold',
  LOOT_PXP: 's.loot.pxp',
  COMBAT_XP: 's.combat.xp',

  // combat state
  ATTACK: 's.combat.attack',
  DAMAGE: 's.combat.damage',
  DEATH: 's.combat.death',
  RESPAWN: 's.combat.respawn',
  CAST: 's.combat.cast',
  CAST_DENIED: 's.combat.castdenied',
  CD_SET: 's.combat.cdset',
  CD_REDUCE: 's.combat.cdreduce',
  TELEGRAPH: 's.combat.telegraph',
  TELEGRAPH_CANCEL: 's.combat.telegraphcancel',
  STUN: 's.combat.stun',
  FREEZE: 's.combat.freeze',
  DODGE: 's.combat.dodge',
  BOSS_PHASE: 's.combat.bossphase',
  MEGABOSS: 's.combat.megaboss',

  // inventory & progression
  INV_SYNC: 's.inv.sync',
  ITEM_USED: 's.item.used',
  ATTRS_SET: 's.attrs.set',
  TALENTS_SET: 's.talents.set',
  LOADOUT_LOCKED: 's.loadout.locked',
  HERO_SCALE: 's.hero.scale',

  // shops
  SHOP_STOCK: 's.shop.stock',
  RARESHOP_STOCK: 's.rareshop.stock',
  WANDERING_SHOP: 's.wandering.shop',
} as const;

export type SignalType = (typeof SIG)[keyof typeof SIG];

/** Signals worth an entry in the value ledger. */
export const VALUE_SIGNALS: readonly string[] = [
  SIG.LOOT_GOLD,
  SIG.LOOT_PXP,
  SIG.COMBAT_XP,
] as const;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pick(o: unknown, keys: readonly string[]): unknown {
  if (!o || typeof o !== 'object') return undefined;
  const r = o as Record<string, unknown>;
  for (const k of keys) if (r[k] !== undefined) return r[k];
  return undefined;
}

export interface InventoryEntry {
  instanceId?: string;
  itemId?: string;
  name: string;
  slot?: string;
  rarity?: string;
  quantity?: number;
  equipped?: boolean;
  consumable?: boolean;
  /** Item level, instances only. The server's own power ordering. */
  ilvl?: number;
  /** Level required to equip. Equipping below this is refused. */
  levelReq?: number;
  /** Class an instance is restricted to, when it is restricted. */
  classId?: string;
}

/**
 * Parse one `instances[]` element — equipment.
 *
 * Real shape, captured live 2026-08-30:
 *   { id, defId, name, rarity, slot, classId, ilvl, levelReq, dropRebirthLevel,
 *     hasGemSocket, gemSocketCount, socketedGemIds[], affixes{}, lines[],
 *     state, equippedSlot, iconUrl }
 *
 * Note `id` — NOT `instanceId` — and `equippedSlot`/`state` rather than an
 * `equipped` boolean.
 */
function parseInstance(r: Record<string, unknown>): InventoryEntry | null {
  const name = typeof r.name === 'string' ? r.name : null;
  const id = typeof r.id === 'string' ? r.id : null;
  if (!name || !id) return null;

  const e: InventoryEntry = { name, instanceId: id, consumable: false };
  if (typeof r.defId === 'string') e.itemId = r.defId;
  if (typeof r.slot === 'string') e.slot = r.slot;
  if (typeof r.rarity === 'string') e.rarity = r.rarity;
  if (typeof r.classId === 'string') e.classId = r.classId;
  if (typeof r.ilvl === 'number') e.ilvl = r.ilvl;
  if (typeof r.levelReq === 'number') e.levelReq = r.levelReq;

  // Two independent signals for "is this worn". Both are accepted because the
  // exact vocabulary of `state` is not yet confirmed, and treating an equipped
  // item as spare would make the bot try to re-equip or sell what it is wearing.
  const state = typeof r.state === 'string' ? r.state.toLowerCase() : null;
  const slotIdx = typeof r.equippedSlot === 'number' ? r.equippedSlot : null;
  e.equipped = state === 'equipped' || (slotIdx !== null && slotIdx >= 0);
  return e;
}

/**
 * Parse one `stacks[]` element — consumables and materials.
 *
 * Real shape: { itemId, name, rarity, quantity, iconUrl, soulbound }.
 * There is NO `consumable` flag, so it is inferred from the name: potions and
 * food are the only stackables worth using mid-run.
 */
function parseStack(r: Record<string, unknown>): InventoryEntry | null {
  const name = typeof r.name === 'string' ? r.name : null;
  const itemId = typeof r.itemId === 'string' ? r.itemId : null;
  if (!name || !itemId) return null;

  const e: InventoryEntry = { name, itemId };
  if (typeof r.rarity === 'string') e.rarity = r.rarity;
  if (typeof r.quantity === 'number') e.quantity = r.quantity;
  // Consumable by name: the server does not label it. Conservative on purpose —
  // a misclassified gem would be "used" every tick and refused every tick.
  e.consumable = /potion|elixir|flask|draught|tonic|food|ration|bread|meat|fruit|remedy|salve/i.test(
    name,
  );
  return e;
}

/**
 * Live view of everything the `s.*` stream tells us.
 *
 * Kept as plain observed state rather than inferred: if the server never sent
 * it, it stays null, and callers decide what to do about that.
 */
export class SignalState {
  private _inventory: InventoryEntry[] = [];
  private _gold: number | null = null;
  private _xp: number | null = null;
  /** Level, from the authoritative `s.combat.xp` payload. */
  private _level: number | null = null;
  /**
   * Set when the server says a level was gained. Latched, not momentary: the
   * caller drains it, because a level-up grants attribute points and the tick
   * that notices must be free to act on them.
   */
  private _leveledUp = false;
  private _cooldowns = new Map<string, number>();
  private _dead = false;
  /** Carried-inventory slot capacity, from `s.inv.sync`. */
  private _capacity: number | null = null;
  private _lastTelegraphAt = 0;
  private _resync: { col: number; row: number } | null = null;
  /**
   * Route the server last computed for us, from `s.path`.
   *
   * Server-authoritative and wall-aware, which is the whole point: the bot's own
   * dead reckoning cannot see walls and got refused against them.
   */
  private _path: { col: number; row: number }[] = [];
  private _pathFrom: { col: number; row: number } | null = null;
  private _pathAt = 0;
  private _goldGained = 0;
  private _xpGained = 0;
  /** Mob deaths observed this run, with whatever name the server gave. */
  private _kills: string[] = [];

  get inventory(): readonly InventoryEntry[] {
    return this._inventory;
  }
  get gold(): number | null {
    return this._gold;
  }
  get xp(): number | null {
    return this._xp;
  }
  /** Level as the server last reported it on `s.combat.xp`. */
  get level(): number | null {
    return this._level;
  }
  /**
   * Take the pending level-up notice, if any.
   *
   * Drained rather than read so a single level-up triggers exactly one attribute
   * spend, however many ticks pass before the caller gets to it.
   */
  takeLevelUp(): boolean {
    const up = this._leveledUp;
    this._leveledUp = false;
    return up;
  }
  get dead(): boolean {
    return this._dead;
  }
  /** Carried inventory capacity, null until the first sync. */
  get capacity(): number | null {
    return this._capacity;
  }
  get goldGained(): number {
    return this._goldGained;
  }
  get xpGained(): number {
    return this._xpGained;
  }

  /** Take the kills seen since the last call, so each is counted once. */
  drainKills(): string[] {
    const out = this._kills;
    this._kills = [];
    return out;
  }

  /** A pending resync the server asked for after refusing a move. */
  takeResync(): { col: number; row: number } | null {
    const r = this._resync;
    this._resync = null;
    return r;
  }

  /**
   * The route the server last handed back, if it is still fresh.
   *
   * Staleness matters: a path computed for a position we have since left would
   * walk the hero backwards. `maxAgeMs` bounds that. `now` is injectable for the
   * same reason `underTelegraph()` takes it — a test must not depend on whether
   * two calls land in the same millisecond.
   */
  path(maxAgeMs = 5_000, now = Date.now()): readonly { col: number; row: number }[] {
    if (this._path.length === 0) return [];
    return now - this._pathAt <= maxAgeMs ? this._path : [];
  }

  /** Cell the server said the last route started from. */
  get pathFrom(): { col: number; row: number } | null {
    return this._pathFrom;
  }

  /** Drop the stored route once it has been consumed or invalidated. */
  clearPath(): void {
    this._path = [];
    this._pathFrom = null;
    this._pathAt = 0;
  }

  /** True when an attack telegraph landed recently enough to still matter. */
  underTelegraph(withinMs = 1_200, now = Date.now()): boolean {
    return this._lastTelegraphAt > 0 && now - this._lastTelegraphAt <= withinMs;
  }

  cooldownReadyAt(abilityId: string): number | undefined {
    return this._cooldowns.get(abilityId);
  }

  abilityReady(abilityId: string, now = Date.now()): boolean {
    const at = this._cooldowns.get(abilityId);
    return at === undefined || at <= now;
  }

  /** Feed one signal. Unknown types are ignored, not treated as errors. */
  apply(type: string, payload: unknown, selfId: string | null): void {
    switch (type) {
      case SIG.INV_SYNC: {
        // Real payload, captured live 2026-08-30, is NOT a flat list:
        //   { gold, pxp, capacity, instances[], stacks[], stashInstances[],
        //     stashStacks[], containers{}, artifactPointsAvailable, ... }
        //
        // The previous code probed `items` / `inventory` / `entries` — none of
        // which exist — so `_inventory` stayed empty for the bot's entire life.
        // That silently disabled potions, equipping AND selling: every
        // inventory-driven decision was dead code, which is why the fleet wiped
        // at depth 1 with a bag full of unused gear.
        //
        // `stash*` is deliberately excluded: it is town storage, not carried,
        // and cannot be used or equipped mid-run.
        const rec = (payload && typeof payload === 'object'
          ? (payload as Record<string, unknown>)
          : {}) as Record<string, unknown>;

        const objects = (v: unknown): Record<string, unknown>[] =>
          Array.isArray(v)
            ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
            : [];

        const next: InventoryEntry[] = [];
        for (const r of objects(rec.instances)) {
          const e = parseInstance(r);
          if (e) next.push(e);
        }
        for (const r of objects(rec.stacks)) {
          const e = parseStack(r);
          if (e) next.push(e);
        }

        // Only replace on a payload that actually carried the arrays. A partial
        // sync must not silently empty the bag.
        if (Array.isArray(rec.instances) || Array.isArray(rec.stacks)) {
          this._inventory = next;
          const gold = num(rec.gold);
          if (gold !== null) this._gold = gold;
          this._capacity = num(rec.capacity);
          log.debug(
            `inventory sync: ${next.length} item(s) ` +
              `(${next.filter((e) => !e.consumable).length} gear, ` +
              `${next.filter((e) => e.consumable).length} consumable)` +
              // Names and slots, so a "nothing ever equips" symptom can be told
              // apart from "there is nothing worth equipping".
              (next.length > 0
                ? `: ${next
                    .map(
                      (e) =>
                        `${e.name}[${e.consumable ? `x${e.quantity ?? 1}` : `${e.slot ?? 'noslot'} ilvl${e.ilvl ?? '?'}${e.equipped ? ' WORN' : ''}`}]`,
                    )
                    .join(', ')}`
                : ''),
          );
        }
        break;
      }

      case SIG.LOOT_GOLD: {
        // Real payload: { amount, col, row, big, golden }. There is NO running
        // total here — `total`/`balance` were probed and neither exists, so
        // `_gold` was never once set from a gold pickup. The authoritative total
        // arrives on s.combat.xp instead (see below).
        const amount = num(pick(payload, ['amount', 'gold', 'value']));
        const total = num(pick(payload, ['total', 'balance']));
        if (amount !== null && amount > 0) this._goldGained += amount;
        if (total !== null) this._gold = total;
        break;
      }

      case SIG.LOOT_PXP:
      case SIG.COMBAT_XP: {
        // Real s.combat.xp payload: { amount, xp, level, gold, leveledUp }.
        //
        // `level`, `gold` and `leveledUp` were all ignored. That mattered:
        // `gold` is the running total the gold-pickup signal does not carry, and
        // `leveledUp` is the only positive notice that attribute points were
        // just granted — everything else had to infer it by polling room state.
        const amount = num(pick(payload, ['amount', 'xp', 'value']));
        const total = num(pick(payload, ['total', 'xp']));
        if (amount !== null && amount > 0) this._xpGained += amount;
        if (total !== null) this._xp = total;

        const gold = num(pick(payload, ['gold']));
        if (gold !== null) this._gold = gold;

        const level = num(pick(payload, ['level']));
        if (level !== null) {
          if (this._level !== null && level > this._level) this._leveledUp = true;
          this._level = level;
        }
        // Trust the server's own flag over the comparison when it is present.
        const flag = pick(payload, ['leveledUp']);
        if (flag === true) this._leveledUp = true;
        break;
      }

      case SIG.CD_SET: {
        const id = pick(payload, ['abilityId', 'id', 'spellId']);
        const ms = num(pick(payload, ['ms', 'durationMs', 'cooldownMs', 'duration']));
        const until = num(pick(payload, ['readyAt', 'until']));
        if (typeof id === 'string') {
          if (until !== null) this._cooldowns.set(id, until);
          else if (ms !== null) this._cooldowns.set(id, Date.now() + ms);
        }
        break;
      }

      case SIG.CD_REDUCE: {
        const id = pick(payload, ['abilityId', 'id', 'spellId']);
        const ms = num(pick(payload, ['ms', 'amount']));
        if (typeof id === 'string' && ms !== null) {
          const cur = this._cooldowns.get(id);
          if (cur !== undefined) this._cooldowns.set(id, Math.max(Date.now(), cur - ms));
        }
        break;
      }

      case SIG.TELEGRAPH:
        this._lastTelegraphAt = Date.now();
        break;

      case SIG.TELEGRAPH_CANCEL:
        this._lastTelegraphAt = 0;
        break;

      case SIG.DEATH: {
        const who = pick(payload, ['id', 'sessionId', 'userId']);
        if (selfId && typeof who === 'string' && who === selfId) {
          this._dead = true;
          log.warn('hero died');
        } else {
          // Anything else dying is a kill. The server does not send a separate
          // "you killed X" signal — this is the only kill evidence there is.
          const name = pick(payload, ['name', 'monsterId', 'kind', 'type']);
          this._kills.push(typeof name === 'string' && name ? name : 'unknown');
        }
        break;
      }

      case SIG.RESPAWN:
        this._dead = false;
        break;

      case SIG.MOVE_DENIED: {
        const col = num(pick(payload, ['col']));
        const row = num(pick(payload, ['row']));
        if (col !== null && row !== null) this._resync = { col, row };
        break;
      }

      case SIG.PATH: {
        // Real payload: { seq, fc, fr, cells:[...] } — a flat number array of
        // col,row pairs, observed up to 154 entries long. The server pathfinds
        // for us: an `i.move` naming a distant cell is answered with the whole
        // route, walls avoided.
        //
        // This case did not exist. `s.path` was declared in SIG and then never
        // handled, so the one signal that says "your move was accepted, here is
        // the way" was dropped on the floor while the bot guessed single steps
        // and got refused against walls.
        const cells = pick(payload, ['cells']);
        const fc = num(pick(payload, ['fc']));
        const fr = num(pick(payload, ['fr']));
        if (!Array.isArray(cells)) break;

        const route: { col: number; row: number }[] = [];
        // Pairs. An odd tail would silently shift every later cell by one, so a
        // malformed array is rejected outright rather than half-read.
        if (cells.length % 2 !== 0) break;
        for (let i = 0; i < cells.length; i += 2) {
          const c = num(cells[i]);
          const r = num(cells[i + 1]);
          if (c === null || r === null) return;
          route.push({ col: c, row: r });
        }
        this._path = route;
        this._pathFrom = fc !== null && fr !== null ? { col: fc, row: fr } : null;
        this._pathAt = Date.now();
        break;
      }

      default:
        break;
    }
  }

  /** Reset per-run counters when a new dungeon starts. */
  resetRun(): void {
    this._goldGained = 0;
    this._xpGained = 0;
    this._kills = [];
    this._dead = false;
    this._lastTelegraphAt = 0;
    // A route from the previous floor is worse than none: the cells are valid
    // coordinates in a dungeon that no longer exists.
    this.clearPath();
    // Cleared with the other per-run state. Losing an unacted notice is safe
    // because it is only a notice: the attribute spend is driven by
    // `bonusAttrPoints` on the player record, which stays non-zero until the
    // points are actually spent. `_level` and `_gold` are server truth about the
    // character rather than the run, so they deliberately survive.
    this._leveledUp = false;
  }
}
