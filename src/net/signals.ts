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
  private _cooldowns = new Map<string, number>();
  private _dead = false;
  private _lastTelegraphAt = 0;
  private _resync: { col: number; row: number } | null = null;
  private _goldGained = 0;
  private _xpGained = 0;

  get inventory(): readonly InventoryEntry[] {
    return this._inventory;
  }
  get gold(): number | null {
    return this._gold;
  }
  get xp(): number | null {
    return this._xp;
  }
  get dead(): boolean {
    return this._dead;
  }
  get goldGained(): number {
    return this._goldGained;
  }
  get xpGained(): number {
    return this._xpGained;
  }

  /** A pending resync the server asked for after refusing a move. */
  takeResync(): { col: number; row: number } | null {
    const r = this._resync;
    this._resync = null;
    return r;
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
        const list = pick(payload, ['items', 'inventory', 'entries']);
        if (Array.isArray(list)) {
          this._inventory = list
            .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object')
            .map((r) => {
              const name = typeof r.name === 'string' ? r.name : String(r.itemId ?? '');
              const e: InventoryEntry = { name };
              if (typeof r.instanceId === 'string') e.instanceId = r.instanceId;
              if (typeof r.itemId === 'string') e.itemId = r.itemId;
              if (typeof r.slot === 'string') e.slot = r.slot;
              if (typeof r.rarity === 'string') e.rarity = r.rarity;
              if (typeof r.quantity === 'number') e.quantity = r.quantity;
              if (typeof r.equipped === 'boolean') e.equipped = r.equipped;
              if (typeof r.consumable === 'boolean') e.consumable = r.consumable;
              return e;
            })
            .filter((e) => e.name.length > 0);
          log.debug(`inventory sync: ${this._inventory.length} item(s)`);
        }
        break;
      }

      case SIG.LOOT_GOLD: {
        const amount = num(pick(payload, ['amount', 'gold', 'value']));
        const total = num(pick(payload, ['total', 'balance']));
        if (amount !== null && amount > 0) this._goldGained += amount;
        if (total !== null) this._gold = total;
        break;
      }

      case SIG.LOOT_PXP:
      case SIG.COMBAT_XP: {
        const amount = num(pick(payload, ['amount', 'xp', 'value']));
        const total = num(pick(payload, ['total', 'xp']));
        if (amount !== null && amount > 0) this._xpGained += amount;
        if (total !== null) this._xp = total;
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
        // Only our own death changes what the bot should do.
        const who = pick(payload, ['id', 'sessionId', 'userId']);
        if (selfId && typeof who === 'string' && who === selfId) {
          this._dead = true;
          log.warn('hero died');
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

      default:
        break;
    }
  }

  /** Reset per-run counters when a new dungeon starts. */
  resetRun(): void {
    this._goldGained = 0;
    this._xpGained = 0;
    this._dead = false;
    this._lastTelegraphAt = 0;
  }
}
