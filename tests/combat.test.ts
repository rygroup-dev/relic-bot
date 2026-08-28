import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  combatCandidates,
  lootCandidates,
  tooHurtToFight,
  healthFraction,
  parseCandidateId,
  DEFAULT_COMBAT_TUNING,
} from '../src/game/combat.js';
import { readEntities, readSelf, distance } from '../src/game/state.js';
import { CombatMemory } from '../src/safety/ledger.js';

let dir: string;
let memory: CombatMemory;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relic-combat-'));
  memory = new CombatMemory(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const self = { id: 's', pos: { x: 0, y: 0 }, hp: 100, maxHp: 100, level: 5, gold: 0 };

const monster = (id: string, x: number, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'monster' as const,
  name: over.name as string ?? id,
  pos: { x, y: 0 },
  hp: (over.hp as number) ?? 50,
  maxHp: (over.maxHp as number) ?? 50,
  level: 5,
  raw: {},
});

describe('health gating', () => {
  it('computes the health fraction', () => {
    expect(healthFraction(self)).toBe(1);
    expect(healthFraction({ ...self, hp: 45 })).toBe(0.45);
    expect(healthFraction({ ...self, maxHp: 0 })).toBeNull();
  });

  it('refuses to fight below the HP floor', () => {
    expect(tooHurtToFight({ ...self, hp: 40 }, DEFAULT_COMBAT_TUNING)).toBe(true);
    expect(tooHurtToFight({ ...self, hp: 50 }, DEFAULT_COMBAT_TUNING)).toBe(false);
  });

  it('does not refuse when HP is unknown', () => {
    expect(tooHurtToFight({ ...self, hp: null }, DEFAULT_COMBAT_TUNING)).toBe(false);
  });

  it('produces zero candidates when too hurt — "do nothing" is a real outcome', () => {
    const out = combatCandidates({ ...self, hp: 10 }, [monster('a', 1)], memory, 'w1');
    expect(out).toEqual([]);
  });
});

describe('target scoring', () => {
  it('prefers nearer targets', () => {
    const out = combatCandidates(self, [monster('far', 10), monster('near', 1)], memory, 'w1');
    expect(out[0]!.id).toBe('attack:near');
  });

  it('drops targets beyond engage range', () => {
    const out = combatCandidates(self, [monster('a', 999)], memory, 'w1');
    expect(out).toEqual([]);
  });

  it('skips already-dead monsters', () => {
    const out = combatCandidates(self, [monster('dead', 1, { hp: 0 })], memory, 'w1');
    expect(out).toEqual([]);
  });

  it('down-weights a monster we keep losing to', () => {
    for (let i = 0; i < 10; i++) memory.record('w1', 'nemesis', 'loss');
    const out = combatCandidates(
      self,
      [monster('m1', 2, { name: 'nemesis' }), monster('m2', 2, { name: 'stranger' })],
      memory,
      'w1',
    );
    const nemesis = out.find((c) => c.facts?.monster === 'nemesis')!;
    const stranger = out.find((c) => c.facts?.monster === 'stranger')!;
    expect(nemesis.score).toBeLessThan(stranger.score);
  });

  it('still tries an unknown monster rather than avoiding it forever', () => {
    const out = combatCandidates(self, [monster('new', 1, { name: 'unseen' })], memory, 'w1');
    expect(out).toHaveLength(1);
    expect(out[0]!.rationale).toContain('winrate=unknown');
  });

  it('caps the candidate list so prompts stay small', () => {
    const many = Array.from({ length: 30 }, (_, i) => monster(`m${i}`, 1));
    expect(combatCandidates(self, many, memory, 'w1').length).toBeLessThanOrEqual(8);
  });
});

describe('loot', () => {
  it('surfaces loot in reach, nearest first', () => {
    const loot = [
      { id: 'l1', kind: 'loot' as const, name: 'Gem', pos: { x: 5, y: 0 }, hp: null, maxHp: null, level: null, raw: {} },
      { id: 'l2', kind: 'loot' as const, name: 'Coin', pos: { x: 1, y: 0 }, hp: null, maxHp: null, level: null, raw: {} },
    ];
    const out = lootCandidates(self, loot);
    expect(out[0]!.id).toBe('loot:l2');
  });
});

describe('candidate ids round-trip', () => {
  it('parses action and target', () => {
    expect(parseCandidateId('attack:mob-7')).toEqual({ action: 'attack', target: 'mob-7' });
    expect(parseCandidateId('loot:abc:def')).toEqual({ action: 'loot', target: 'abc:def' });
  });
  it('rejects malformed ids', () => {
    expect(parseCandidateId('nocolon')).toBeNull();
    expect(parseCandidateId(':leading')).toBeNull();
  });
});

describe('state adapter tolerates an unknown schema', () => {
  it('returns nothing for junk instead of throwing', () => {
    for (const junk of [null, undefined, 42, 'str', {}, []]) {
      expect(() => readEntities(junk)).not.toThrow();
      expect(readEntities(junk)).toEqual([]);
    }
  });

  it('ignores config-like records that have neither position nor hp', () => {
    const state = { settings: { tickRate: { value: 30 } } };
    expect(readEntities(state)).toEqual([]);
  });

  it('extracts entities from a Map-like collection', () => {
    const monsters = new Map([['m1', { x: 3, y: 4, hp: 10, maxHp: 20, name: 'Troll' }]]);
    const out = readEntities({ monsters });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('monster');
    expect(out[0]!.name).toBe('Troll');
    expect(out[0]!.pos).toEqual({ x: 3, y: 4 });
  });

  it('finds self by session id', () => {
    const players = { abc: { x: 1, y: 2, hp: 80, maxHp: 100, gold: 5 } };
    const me = readSelf({ players }, 'abc');
    expect(me.hp).toBe(80);
    expect(me.gold).toBe(5);
  });

  it('returns an empty self when the session is unknown', () => {
    expect(readSelf({ players: {} }, 'missing').hp).toBeNull();
  });

  it('measures euclidean distance', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});
