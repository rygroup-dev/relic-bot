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
 * Uses the market-calibrated rarity value as the comparison, because that is
 * the only ordering we have evidence for — the client does not expose an
 * item power score.
 */
export function equipIntent(inventory: readonly InventoryItem[]): ActionIntent | null {
  const equippedBySlot = new Map<string, InventoryItem>();
  for (const i of inventory) {
    if (i.equipped && i.slot) equippedBySlot.set(i.slot, i);
  }

  let best: { item: InventoryItem; gain: number } | null = null;
  for (const item of inventory) {
    if (item.equipped || item.consumable || !item.slot || !item.instanceId) continue;
    const current = equippedBySlot.get(item.slot);
    const mine = lootPriority(item.rarity);
    const theirs = current ? lootPriority(current.rarity) : 0;
    const gain = mine - theirs;
    if (gain <= 0) continue;
    if (!best || gain > best.gain) best = { item, gain };
  }
  if (!best) return null;

  return {
    type: MSG.INV_EQUIP,
    payload: { instanceId: best.item.instanceId, slot: best.item.slot },
    label: `equip ${best.item.name}`,
    reason: `${best.item.rarity ?? 'unknown'} upgrade for the ${best.item.slot} slot`,
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
  } = {},
): ActionIntent[] {
  const tuning = opts.tuning ?? DEFAULT_SURVIVAL;
  const out: (ActionIntent | null)[] = [
    healingIntent(self, inventory, tuning),
    chestIntent(entities),
    castIntent(self, opts.abilities ?? [], opts.targetId ?? null),
    equipIntent(inventory),
    manaIntent(self, inventory, tuning),
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
