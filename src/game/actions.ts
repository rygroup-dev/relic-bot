/**
 * Character management: consumables, abilities, equipment, attributes, chests.
 *
 * These are the actions that keep a hero alive and growing between fights. They
 * are pure decision functions returning an intent, so they can be tested
 * without a server and so Otak can re-rank them exactly like combat choices.
 *
 * Every one runs with the LLM off. Otak improves the ordering; it never gates
 * whether these happen at all.
 *
 * Payloads verified against the client's own send* wrappers:
 *   i.use         { itemId }
 *   i.cast        { abilityId, ...extra }
 *   i.inv.equip   { instanceId, slot }
 *   i.inv.unequip { slot }
 *   i.attrs.set   { alloc }
 *   i.chest.open  { chestId }
 *   i.roll        { ...extra }
 *
 * Note: this game has no gathering, mining, fishing or crafting — the message
 * vocabulary contains nothing of the sort. "Farming" here means killing mobs
 * and collecting drops.
 */

import { MSG, ATTRIBUTES, type Attribute, type ClassId } from '../protocol/messages.js';
import type { Candidate } from '../otak/types.js';
import type { SelfView, EntityView } from './state.js';
import { lootPriority } from '../economy/valuation.js';

export interface InventoryItem {
  instanceId?: string;
  itemId?: string;
  name: string;
  slot?: string;
  rarity?: string;
  /** True when the item is a consumable rather than equipment. */
  consumable?: boolean;
  /** Rough heal/restore amount, when the server exposes one. */
  restores?: 'hp' | 'mana' | null;
  quantity?: number;
  equipped?: boolean;
  /**
   * Item level — the server's own power ordering, present on every instance.
   *
   * This is strictly better evidence than rarity for "is this an upgrade": a
   * high-ilvl rare beats a low-ilvl epic, and the equip decision used to rank
   * on rarity alone because ilvl was never parsed out of `s.inv.sync`.
   */
  ilvl?: number;
  /** Level required to equip. Below it the server refuses the equip. */
  levelReq?: number;
  /** Class restriction, when the item has one. */
  classId?: string;
}

export interface Ability {
  abilityId: string;
  name?: string;
  manaCost?: number;
  readyAt?: number;
}

/** A decision the account loop can execute directly. */
export interface ActionIntent {
  type: string;
  payload: Record<string, unknown>;
  label: string;
  reason: string;
  /** 0..1, higher runs first. */
  priority: number;
}

export interface SurvivalTuning {
  /** Drink below this fraction of max HP. */
  healBelow: number;
  /** Consider a mana potion below this fraction. */
  manaBelow: number;
}

export const DEFAULT_SURVIVAL: SurvivalTuning = { healBelow: 0.5, manaBelow: 0.25 };

function fraction(cur: number | null, max: number | null): number | null {
  if (cur === null || max === null || max <= 0) return null;
  return cur / max;
}

/**
 * Drink a potion when hurt.
 *
 * Ranked above everything else: a dead hero loses the run, and death is the
 * single most expensive event in a dungeon crawler.
 */
export function healingIntent(
  self: SelfView,
  inventory: readonly InventoryItem[],
  tuning: SurvivalTuning = DEFAULT_SURVIVAL,
): ActionIntent | null {
  const hpFrac = fraction(self.hp, self.maxHp);
  if (hpFrac === null || hpFrac > tuning.healBelow) return null;

  const potion = inventory.find(
    (i) => i.consumable && i.restores === 'hp' && (i.quantity ?? 1) > 0 && i.itemId,
  );
  if (!potion?.itemId) return null;

  return {
    type: MSG.USE,
    payload: { itemId: potion.itemId },
    label: `drink ${potion.name}`,
    reason: `hp at ${Math.round(hpFrac * 100)}%, below the ${Math.round(tuning.healBelow * 100)}% floor`,
    priority: 1,
  };
}

export function manaIntent(
  self: SelfView,
  inventory: readonly InventoryItem[],
  tuning: SurvivalTuning = DEFAULT_SURVIVAL,
): ActionIntent | null {
  const frac = fraction(self.mana, self.maxMana);
  if (frac === null || frac > tuning.manaBelow) return null;

  const potion = inventory.find(
    (i) => i.consumable && i.restores === 'mana' && (i.quantity ?? 1) > 0 && i.itemId,
  );
  if (!potion?.itemId) return null;

  return {
    type: MSG.USE,
    payload: { itemId: potion.itemId },
    label: `drink ${potion.name}`,
    reason: `mana at ${Math.round(frac * 100)}%`,
    priority: 0.55,
  };
}

/**
 * Cast an ability at a target.
 *
 * Only offered when mana actually covers the cost and the cooldown has expired,
 * so a refused cast never becomes a silent no-op loop.
 */
export function castIntent(
  self: SelfView,
  abilities: readonly Ability[],
  targetId: string | null,
  now = Date.now(),
): ActionIntent | null {
  if (!targetId) return null;

  const usable = abilities.filter((a) => {
    if (a.readyAt !== undefined && a.readyAt > now) return false;
    if (a.manaCost !== undefined && self.mana !== null && self.mana < a.manaCost) return false;
    return Boolean(a.abilityId);
  });
  if (usable.length === 0) return null;

  // Most expensive affordable ability first: cooldowns make cheap spam the
  // weaker play, and mana regenerates.
  const pick = usable.reduce((a, b) => ((b.manaCost ?? 0) > (a.manaCost ?? 0) ? b : a));
  return {
    type: MSG.CAST,
    payload: { abilityId: pick.abilityId, targetId },
    label: `cast ${pick.name ?? pick.abilityId}`,
    reason: `ready, costs ${pick.manaCost ?? 0} of ${self.mana ?? '?'} mana`,
    priority: 0.8,
  };
}

/**
 * Equip a strictly better item for an empty or weaker slot.
 *
 * Ranks on `ilvl` — the server's own power number, present on every instance —
 * with rarity as the tiebreak. It used to rank on rarity ALONE, which called a
 * level-1 epic an upgrade over a level-40 rare; ilvl was in the payload the
 * whole time but `s.inv.sync` was never parsed, so the inventory was always
 * empty and this function never ran at all.
 *
 * Two server-side refusals are respected rather than discovered by being
 * rejected every tick:
 *   - `levelReq` above the hero's level
 *   - `classId` belonging to another class
 */
export function equipIntent(
  inventory: readonly InventoryItem[],
  self?: SelfView,
  classId?: ClassId | null,
): ActionIntent | null {
  const equippedBySlot = new Map<string, InventoryItem>();
  for (const i of inventory) {
    if (i.equipped && i.slot) equippedBySlot.set(i.slot, i);
  }

  // Power = ilvl when the server gave one, else the market-calibrated rarity
  // ordering. Scaled so a rarity-only comparison never outranks a real ilvl.
  const power = (i: InventoryItem | undefined): number => {
    if (!i) return 0;
    if (typeof i.ilvl === 'number') return i.ilvl * 100 + lootPriority(i.rarity);
    return lootPriority(i.rarity);
  };

  let best: { item: InventoryItem; gain: number } | null = null;
  for (const item of inventory) {
    if (item.equipped || item.consumable || !item.slot || !item.instanceId) continue;
    // The server refuses these; offering them would loop forever at zero errors.
    if (
      typeof item.levelReq === 'number' &&
      self?.level !== null &&
      self?.level !== undefined &&
      item.levelReq > self.level
    ) {
      continue;
    }
    if (item.classId && classId && item.classId !== classId) continue;

    const gain = power(item) - power(equippedBySlot.get(item.slot));
    if (gain <= 0) continue;
    if (!best || gain > best.gain) best = { item, gain };
  }
  if (!best) return null;

  const current = best.item.slot ? equippedBySlot.get(best.item.slot) : undefined;
  return {
    type: MSG.INV_EQUIP,
    payload: { instanceId: best.item.instanceId, slot: best.item.slot },
    label: `equip ${best.item.name}`,
    reason:
      `ilvl ${best.item.ilvl ?? '?'} ${best.item.rarity ?? 'unknown'} for the ` +
      `${best.item.slot} slot, replacing ilvl ${current?.ilvl ?? 'nothing'}`,
    priority: 0.6,
  };
}

/** Open a chest that is in reach. Free value, no risk. */
export function chestIntent(entities: readonly EntityView[]): ActionIntent | null {
  const chest = entities.find(
    (e) => /chest/i.test(e.name) || /chest/i.test(String(e.raw && (e.raw as { type?: string }).type)),
  );
  if (!chest) return null;
  return {
    type: MSG.CHEST_OPEN,
    payload: { chestId: chest.id },
    label: `open ${chest.name}`,
    reason: 'chest in reach',
    priority: 0.9,
  };
}

/**
 * Spend unallocated attribute points.
 *
 * Vitality first: survival compounds in a dungeon crawler where death ends the
 * run, and every class benefits from not dying. The rest goes to the class's
 * primary stat.
 */
export const PRIMARY_ATTRIBUTE: Record<ClassId, Attribute> = {
  knight: 'strength',
  hunter: 'dexterity',
  rogue: 'dexterity',
  assassin: 'dexterity',
  mage: 'intelligence',
  necromancer: 'spirit',
};

export function attributeIntent(
  classId: ClassId | null,
  unspentPoints: number,
  vitalityShare = 0.4,
): ActionIntent | null {
  if (unspentPoints <= 0) return null;

  const alloc: Partial<Record<Attribute, number>> = {};
  const toVitality = Math.max(1, Math.round(unspentPoints * vitalityShare));
  alloc.vitality = toVitality;

  const rest = unspentPoints - toVitality;
  if (rest > 0) {
    const primary = classId ? PRIMARY_ATTRIBUTE[classId] : 'strength';
    alloc[primary] = (alloc[primary] ?? 0) + rest;
  }

  return {
    type: MSG.ATTRS_SET,
    payload: { alloc },
    label: `spend ${unspentPoints} attribute point${unspentPoints === 1 ? '' : 's'}`,
    reason:
      `${toVitality} to vitality for survival` +
      (rest > 0 ? `, ${rest} to ${classId ? PRIMARY_ATTRIBUTE[classId] : 'strength'}` : ''),
    priority: 0.5,
  };
}

/**
 * Collect every applicable intent, highest priority first.
 *
 * This is the complete non-combat action set. It runs identically with the LLM
 * on or off — Otak only reorders what is already here.
 */
export function characterIntents(
  self: SelfView,
  inventory: readonly InventoryItem[],
  entities: readonly EntityView[],
  opts: {
    abilities?: readonly Ability[];
    targetId?: string | null;
    classId?: ClassId | null;
    unspentPoints?: number;
    tuning?: SurvivalTuning;
    /**
     * Hero level, when a more reliable source than `self.level` is available.
     *
     * The room-state read is null until the dungeon schema lands, and
     * equipIntent() skips any item whose `levelReq` it cannot clear — so a null
     * level silently blocked every equip. The caller passes the level from the
     * signal stream, which is authoritative on every kill.
     */
    level?: number | null;
  } = {},
): ActionIntent[] {
  const tuning = opts.tuning ?? DEFAULT_SURVIVAL;
  // Level is overridden rather than merged so an explicit null from the caller
  // still means "unknown", not "fall back to the stale state read".
  const view: SelfView =
    opts.level !== undefined && opts.level !== self.level ? { ...self, level: opts.level } : self;
  const out: (ActionIntent | null)[] = [
    healingIntent(view, inventory, tuning),
    chestIntent(entities),
    castIntent(view, opts.abilities ?? [], opts.targetId ?? null),
    equipIntent(inventory, view, opts.classId ?? null),
    manaIntent(view, inventory, tuning),
    attributeIntent(opts.classId ?? null, opts.unspentPoints ?? 0),
  ];
  return out
    .filter((i): i is ActionIntent => i !== null)
    .sort((a, b) => b.priority - a.priority);
}

/** Render intents as Otak candidates so the brain can re-rank them. */
export function intentsToCandidates(intents: readonly ActionIntent[]): Candidate[] {
  return intents.map((i, idx) => ({
    id: `act:${idx}`,
    label: i.label,
    score: i.priority,
    rationale: i.reason,
  }));
}

export { ATTRIBUTES };
