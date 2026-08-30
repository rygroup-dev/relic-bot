import { describe, it, expect } from 'vitest';
import { CRITICAL_HP_FRACTION } from '../src/fleet/account.js';
import { healingIntent, type InventoryItem } from '../src/game/actions.js';
import {
  tooHurtToFight,
  combatCandidates,
  DEFAULT_COMBAT_TUNING,
} from '../src/game/combat.js';
import { CombatMemory } from '../src/safety/ledger.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SelfView, EntityView } from '../src/game/state.js';

const self = (hp: number, maxHp = 100): SelfView => ({
  id: 's', pos: { x: 0, y: 0 }, hp, maxHp, mana: 50, maxMana: 100,
  level: 1, xp: 0, gold: 0, depth: 1, bonusAttrPoints: 0, raw: {},
});

const mob = (id: string, x = 1): EntityView => ({
  id, kind: 'monster', name: 'Ghoul', pos: { x, y: 0 },
  hp: 40, maxHp: 40, level: 1, raw: {},
});

const hpPotion: InventoryItem = {
  itemId: 'pot', name: 'Healing Potion', consumable: true, restores: 'hp', quantity: 2,
};

describe('the survival threshold is meaningful', () => {
  it('sits below the fight floor, so retreat is a last resort not the norm', () => {
    // Stop fighting at 45%, actively retreat at 35%: there is a band where the
    // bot disengages before it panics.
    expect(CRITICAL_HP_FRACTION).toBeLessThan(DEFAULT_COMBAT_TUNING.minHpFraction);
    expect(CRITICAL_HP_FRACTION).toBeGreaterThan(0);
  });
});

describe('a hurt hero stops trading hits', () => {
  it('offers no combat targets below the fight floor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relic-surv-'));
    try {
      const memory = new CombatMemory(dir);
      // 30% HP is under the 45% floor.
      expect(combatCandidates(self(30), [mob('m1')], memory, 'w1')).toEqual([]);
      // 60% is fine.
      expect(combatCandidates(self(60), [mob('m1')], memory, 'w1').length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('agrees with tooHurtToFight at the boundary', () => {
    expect(tooHurtToFight(self(44), DEFAULT_COMBAT_TUNING)).toBe(true);
    expect(tooHurtToFight(self(46), DEFAULT_COMBAT_TUNING)).toBe(false);
  });
});

describe('drinking beats dying', () => {
  it('drinks at critical HP when a potion exists', () => {
    const i = healingIntent(self(20), [hpPotion]);
    expect(i).not.toBeNull();
    expect(i!.payload).toEqual({ itemId: 'pot' });
  });

  it('has nothing to offer at critical HP with an empty bag — retreat is the only move', () => {
    expect(healingIntent(self(20), [])).toBeNull();
  });

  it('ignores an exhausted stack', () => {
    expect(healingIntent(self(20), [{ ...hpPotion, quantity: 0 }])).toBeNull();
  });
});

describe('REGRESSION: the hero must be able to see itself', () => {
  it('readSelf returns nothing without a session id', async () => {
    const { readSelf } = await import('../src/game/state.js');
    const state = { players: { abc: { x: 1, y: 2, hp: 40, maxHp: 100 } } };

    // This is the bug that made every survival decision dead code: the dungeon
    // tick passed null, so HP was always unknown and the retreat, potion and
    // fight-floor gates could never fire.
    expect(readSelf(state, null).hp).toBeNull();
    expect(readSelf(state, 'abc').hp).toBe(40);
  });

  it('an unknown-HP hero is not treated as a hurt one', async () => {
    const { readSelf } = await import('../src/game/state.js');
    const blind = readSelf({ players: {} }, 'missing');
    // Unknown must not silently read as "fine" or as "critical" — it is neither,
    // and the caller has to notice it cannot see.
    expect(blind.hp).toBeNull();
    expect(blind.maxHp).toBeNull();
    expect(tooHurtToFight(blind, DEFAULT_COMBAT_TUNING)).toBe(false);
  });

  it('reads bonusAttrPoints, the name the server actually sends', async () => {
    const { readSelf } = await import('../src/game/state.js');
    // Live dungeon schema dump 2026-08-30 names it `bonusAttrPoints`. The only
    // reader in src/ looked for `unspentPoints`, which is in no schema, so it
    // always saw 0 and attributeIntent() was never offered once — every hero
    // fought at base vitality for its whole life.
    const state = { players: { abc: { col: 1, row: 2, hp: 70, maxHp: 70, bonusAttrPoints: 5 } } };
    expect(readSelf(state, 'abc').bonusAttrPoints).toBe(5);
    expect(readSelf({ players: { abc: { col: 1, row: 2, hp: 1 } } }, 'abc').bonusAttrPoints)
      .toBeNull();
  });

  it('exposes the raw player record so callers can read unnamed fields', async () => {
    const { readSelf } = await import('../src/game/state.js');
    // `abilities()` read `self.raw` while SelfView had no such field, so it was
    // always undefined — a silent always-empty result, not a type error.
    const player = { col: 1, row: 2, hp: 70, maxHp: 70, boneShield: 12 };
    expect(readSelf({ players: { abc: player } }, 'abc').raw).toEqual(player);
  });
});

describe('REGRESSION: a death must be recorded as a loss', () => {
  it('winRate drops below 1.0 once a loss is recorded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relic-loss-'));
    try {
      const memory = new CombatMemory(dir);
      memory.record('w1', 'Ghoul', 'win');
      memory.record('w1', 'Ghoul', 'win');
      expect(memory.winRate('w1', 'Ghoul')).toBe(1);

      // Live evidence 2026-08-30: 328 run summaries, every one reason="wiped"
      // at depthReached=1, against losses:0 on every wallet — because 'loss'
      // was never passed anywhere in src/. A permanent 1.0 win rate makes the
      // loseAversion term in combatCandidates() inert, so the bot re-picks
      // whatever just killed it.
      memory.record('w1', 'Ghoul', 'loss');
      const wr = memory.winRate('w1', 'Ghoul');
      expect(wr).not.toBeNull();
      expect(wr!).toBeLessThan(1);
      expect(memory.forAccount('w1').Ghoul.losses).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('down-weights a monster that has beaten us', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relic-loss2-'));
    try {
      const naive = new CombatMemory(dir);
      const [fresh] = combatCandidates(self(100), [mob('m1')], naive, 'w1');

      const beaten = new CombatMemory(mkdtempSync(join(tmpdir(), 'relic-loss3-')));
      for (let i = 0; i < 4; i += 1) beaten.record('w1', 'Ghoul', 'loss');
      const [avoided] = combatCandidates(self(100), [mob('m1')], beaten, 'w1');

      // This is the whole point of recording losses: the score must move.
      expect(avoided!.score).toBeLessThan(fresh!.score);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
