/**
 * Combat and loot heuristics — the deterministic layer beneath Otak.
 *
 * These functions are pure so they can be tested without a live server, and so
 * Otak's contribution can be evaluated against a fixed baseline.
 */

import type { Candidate } from '../otak/types.js';
import { distance, type EntityView, type SelfView } from './state.js';
import type { CombatMemory } from '../safety/ledger.js';

export interface CombatTuning {
  /** Refuse to fight below this fraction of max HP. */
  minHpFraction: number;
  /** Ignore targets further away than this. */
  maxEngageDistance: number;
  /** Down-weight monsters we historically lose to. */
  loseAversion: number;
}

export const DEFAULT_COMBAT_TUNING: CombatTuning = {
  minHpFraction: 0.45,
  maxEngageDistance: 12,
  loseAversion: 0.6,
};

export function healthFraction(self: SelfView): number | null {
  if (self.hp === null || self.maxHp === null || self.maxHp <= 0) return null;
  return self.hp / self.maxHp;
}

/** True when the bot is too hurt to start a fight. */
export function tooHurtToFight(self: SelfView, tuning: CombatTuning): boolean {
  const f = healthFraction(self);
  if (f === null) return false; // unknown HP is not a reason to refuse
  return f < tuning.minHpFraction;
}

/**
 * Score monsters into Otak candidates.
 *
 * Scoring favours: close targets, already-wounded targets (faster kills), and
 * monsters we have historically beaten. Returns an empty list when the bot is
 * too hurt — which is what makes "do nothing" a first-class outcome instead of
 * a crash.
 */
export function combatCandidates(
  self: SelfView,
  entities: readonly EntityView[],
  memory: CombatMemory,
  accountId: string,
  tuning: CombatTuning = DEFAULT_COMBAT_TUNING,
): Candidate[] {
  if (tooHurtToFight(self, tuning)) return [];

  const out: Candidate[] = [];
  for (const e of entities) {
    if (e.kind !== 'monster') continue;
    if (e.hp !== null && e.hp <= 0) continue;

    let dist: number | null = null;
    if (self.pos && e.pos) {
      dist = distance(self.pos, e.pos);
      if (dist > tuning.maxEngageDistance) continue;
    }

    // Proximity: 1 at range 0, decaying to 0 at maxEngageDistance.
    const proximity = dist === null ? 0.5 : 1 - Math.min(1, dist / tuning.maxEngageDistance);

    // Wounded targets die faster, so they are worth more per unit of risk.
    const wounded =
      e.hp !== null && e.maxHp !== null && e.maxHp > 0 ? 1 - e.hp / e.maxHp : 0;

    // History: unknown monsters get a neutral 0.5 so they are tried, not avoided
    // forever — otherwise the bot can never learn a new monster is winnable.
    const wr = memory.winRate(accountId, e.name);
    const history = wr === null ? 0.5 : wr;
    const historyWeight = wr === null ? 1 : 1 - tuning.loseAversion * (1 - wr);

    const score = (0.5 * proximity + 0.2 * wounded + 0.3 * history) * historyWeight;

    out.push({
      id: `attack:${e.id}`,
      label: `attack ${e.name}`,
      score: Number(score.toFixed(4)),
      rationale:
        `proximity=${proximity.toFixed(2)} wounded=${wounded.toFixed(2)} ` +
        `winrate=${wr === null ? 'unknown' : wr.toFixed(2)}`,
      facts: {
        monster: e.name,
        distance: dist === null ? 'unknown' : Number(dist.toFixed(2)),
        hp: e.hp ?? 'unknown',
        level: e.level ?? 'unknown',
      },
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

/** Loot within reach, nearest first. Picking loot up is always worth doing. */
export function lootCandidates(
  self: SelfView,
  entities: readonly EntityView[],
  maxDistance = 8,
): Candidate[] {
  const out: Candidate[] = [];
  for (const e of entities) {
    if (e.kind !== 'loot') continue;
    let dist: number | null = null;
    if (self.pos && e.pos) {
      dist = distance(self.pos, e.pos);
      if (dist > maxDistance) continue;
    }
    const proximity = dist === null ? 0.5 : 1 - Math.min(1, dist / maxDistance);
    out.push({
      id: `loot:${e.id}`,
      label: `pick up ${e.name}`,
      score: Number((0.6 + 0.4 * proximity).toFixed(4)),
      rationale: `loot at distance ${dist === null ? 'unknown' : dist.toFixed(2)}`,
      facts: { item: e.name, distance: dist === null ? 'unknown' : Number(dist.toFixed(2)) },
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

/** Parse a candidate id back into an actionable pair. */
export function parseCandidateId(id: string): { action: string; target: string } | null {
  const i = id.indexOf(':');
  if (i <= 0) return null;
  return { action: id.slice(0, i), target: id.slice(i + 1) };
}
