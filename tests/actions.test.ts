import { describe, it, expect } from 'vitest';
import {
  healingIntent,
  manaIntent,
  castIntent,
  equipIntent,
  chestIntent,
  attributeIntent,
  characterIntents,
  intentsToCandidates,
  PRIMARY_ATTRIBUTE,
  DEFAULT_SURVIVAL,
  type InventoryItem,
} from '../src/game/actions.js';
import { MSG, CLASSES } from '../src/protocol/messages.js';
import type { SelfView, EntityView } from '../src/game/state.js';

const self = (over: Partial<SelfView> = {}): SelfView => ({
  id: 's', pos: { x: 0, y: 0 }, hp: 100, maxHp: 100, mana: 100, maxMana: 100,
  level: 5, xp: 0, gold: 0, depth: 1, bonusAttrPoints: 0, raw: {}, ...over,
});

const potion = (restores: 'hp' | 'mana'): InventoryItem => ({
  itemId: `pot_${restores}`, name: `${restores} potion`, consumable: true, restores, quantity: 3,
});

describe('healing comes first — death is the most expensive event', () => {
  it('drinks when below the HP floor', () => {
    const i = healingIntent(self({ hp: 30 }), [potion('hp')]);
    expect(i?.type).toBe(MSG.USE);
    expect(i?.payload).toEqual({ itemId: 'pot_hp' });
    expect(i?.priority).toBe(1);
  });

  it('does not drink when healthy', () => {
    expect(healingIntent(self({ hp: 90 }), [potion('hp')])).toBeNull();
  });

  it('does not drink when there is no potion', () => {
    expect(healingIntent(self({ hp: 10 }), [])).toBeNull();
  });

  it('does not drink a mana potion to heal', () => {
    expect(healingIntent(self({ hp: 10 }), [potion('mana')])).toBeNull();
  });

  it('stays silent when HP is unknown rather than drinking blindly', () => {
    expect(healingIntent(self({ hp: null, maxHp: null }), [potion('hp')])).toBeNull();
  });

  it('outranks every other action', () => {
    const all = characterIntents(self({ hp: 5 }), [potion('hp')], []);
    expect(all[0]!.type).toBe(MSG.USE);
  });
});

describe('mana', () => {
  it('drinks only when genuinely low', () => {
    expect(manaIntent(self({ mana: 10 }), [potion('mana')])).not.toBeNull();
    expect(manaIntent(self({ mana: 80 }), [potion('mana')])).toBeNull();
  });
});

describe('abilities are only offered when actually usable', () => {
  const abilities = [
    { abilityId: 'strike', name: 'Strike', manaCost: 10 },
    { abilityId: 'nova', name: 'Nova', manaCost: 60 },
  ];

  it('picks the strongest affordable ability', () => {
    const i = castIntent(self(), abilities, 'mob-1');
    expect(i?.payload).toEqual({ abilityId: 'nova', targetId: 'mob-1' });
  });

  it('falls back when mana cannot cover the expensive one', () => {
    const i = castIntent(self({ mana: 20 }), abilities, 'mob-1');
    expect(i?.payload).toMatchObject({ abilityId: 'strike' });
  });

  it('respects cooldowns', () => {
    const later = Date.now() + 60_000;
    const i = castIntent(self(), [{ abilityId: 'nova', manaCost: 10, readyAt: later }], 'mob-1');
    expect(i).toBeNull();
  });

  it('never casts without a target', () => {
    expect(castIntent(self(), abilities, null)).toBeNull();
  });

  it('returns null rather than an unusable cast when mana is empty', () => {
    expect(castIntent(self({ mana: 0 }), abilities, 'mob-1')).toBeNull();
  });
});

describe('equipment upgrades', () => {
  it('equips a better item into an occupied slot', () => {
    const inv: InventoryItem[] = [
      { instanceId: 'a', name: 'Old Blade', slot: 'weapon', rarity: 'legendary', equipped: true },
      { instanceId: 'b', name: 'Mythic Blade', slot: 'weapon', rarity: 'mythic' },
    ];
    const i = equipIntent(inv);
    expect(i?.payload).toEqual({ instanceId: 'b', slot: 'weapon' });
  });

  it('fills an empty slot', () => {
    const i = equipIntent([{ instanceId: 'b', name: 'Boots', slot: 'boots', rarity: 'epic' }]);
    expect(i?.payload).toMatchObject({ slot: 'boots' });
  });

  it('does not downgrade', () => {
    const inv: InventoryItem[] = [
      { instanceId: 'a', name: 'Mythic', slot: 'weapon', rarity: 'mythic', equipped: true },
      { instanceId: 'b', name: 'Legendary', slot: 'weapon', rarity: 'legendary' },
    ];
    expect(equipIntent(inv)).toBeNull();
  });

  it('never tries to equip a consumable', () => {
    expect(equipIntent([{ ...potion('hp'), slot: 'weapon', instanceId: 'x' }])).toBeNull();
  });

  // ilvl is the server's own power number, on every instance in s.inv.sync.
  // Ranking on rarity alone called a level-1 epic an upgrade over a level-40
  // rare — and it went unnoticed because the inventory parser matched nothing,
  // so this function never ran against live data at all.
  it('prefers the higher ilvl even when the rarity is lower', () => {
    const inv: InventoryItem[] = [
      { instanceId: 'a', name: 'Worn Epic', slot: 'weapon', rarity: 'epic', ilvl: 5, equipped: true },
      { instanceId: 'b', name: 'Strong Rare', slot: 'weapon', rarity: 'rare', ilvl: 40 },
    ];
    expect(equipIntent(inv)?.payload).toEqual({ instanceId: 'b', slot: 'weapon' });
  });

  it('falls back to rarity when neither item exposes an ilvl', () => {
    const inv: InventoryItem[] = [
      { instanceId: 'a', name: 'Rare', slot: 'ring', rarity: 'rare', equipped: true },
      { instanceId: 'b', name: 'Epic', slot: 'ring', rarity: 'epic' },
    ];
    expect(equipIntent(inv)?.payload).toEqual({ instanceId: 'b', slot: 'ring' });
  });

  it('skips gear above the hero level — the server would refuse it', () => {
    const inv: InventoryItem[] = [
      { instanceId: 'b', name: 'Endgame Blade', slot: 'weapon', rarity: 'mythic', ilvl: 90, levelReq: 40 },
    ];
    // A refused equip is silent: it would be re-offered every tick forever.
    expect(equipIntent(inv, self({ level: 5 }))).toBeNull();
    expect(equipIntent(inv, self({ level: 40 }))).not.toBeNull();
  });

  it('skips gear restricted to another class', () => {
    const inv: InventoryItem[] = [
      { instanceId: 'b', name: 'Mage Staff', slot: 'weapon', rarity: 'epic', ilvl: 20, classId: 'mage' },
    ];
    expect(equipIntent(inv, self(), 'knight')).toBeNull();
    expect(equipIntent(inv, self(), 'mage')).not.toBeNull();
  });

  it('equips unrestricted gear whatever the class', () => {
    const inv: InventoryItem[] = [
      { instanceId: 'b', name: 'Plain Ring', slot: 'ring', rarity: 'rare', ilvl: 10 },
    ];
    expect(equipIntent(inv, self(), 'necromancer')).not.toBeNull();
  });
});

describe('chests are free value', () => {
  it('opens a chest in reach', () => {
    const ent: EntityView[] = [
      { id: 'c1', kind: 'unknown', name: 'Gilded Chest', pos: { x: 1, y: 1 }, hp: null, maxHp: null, level: null, raw: {} },
    ];
    const i = chestIntent(ent);
    expect(i?.type).toBe(MSG.CHEST_OPEN);
    expect(i?.payload).toEqual({ chestId: 'c1' });
  });

  it('ignores a world with no chest', () => {
    expect(chestIntent([])).toBeNull();
  });
});

describe('attribute allocation', () => {
  it('spends nothing when there is nothing to spend', () => {
    expect(attributeIntent('knight', 0)).toBeNull();
  });

  it('puts a share into vitality and the rest into the class primary', () => {
    const i = attributeIntent('mage', 10);
    const alloc = i!.payload.alloc as Record<string, number>;
    expect(alloc.vitality).toBeGreaterThan(0);
    expect(alloc.intelligence).toBeGreaterThan(0);
    expect(Object.values(alloc).reduce((a, b) => a + b, 0)).toBe(10);
  });

  it('never allocates more points than are available', () => {
    for (const n of [1, 2, 3, 7, 25]) {
      const alloc = attributeIntent('knight', n)!.payload.alloc as Record<string, number>;
      expect(Object.values(alloc).reduce((a, b) => a + b, 0)).toBe(n);
    }
  });

  it('has a primary attribute defined for every playable class', () => {
    for (const c of CLASSES) expect(PRIMARY_ATTRIBUTE[c]).toBeTruthy();
  });
});

describe('the full non-combat action set', () => {
  it('works identically without any LLM — these are plain functions', () => {
    const intents = characterIntents(
      self({ hp: 20, mana: 10 }),
      [potion('hp'), potion('mana'), { instanceId: 'x', name: 'Ring', slot: 'ring', rarity: 'mythic' }],
      [],
      { classId: 'knight', unspentPoints: 4, abilities: [{ abilityId: 'cleave', manaCost: 5 }], targetId: 'm1' },
    );
    const types = intents.map((i) => i.type);
    expect(types).toContain(MSG.USE);
    expect(types).toContain(MSG.INV_EQUIP);
    expect(types).toContain(MSG.ATTRS_SET);
    expect(types).toContain(MSG.CAST);
  });

  it('returns them ordered by priority', () => {
    const intents = characterIntents(self({ hp: 10 }), [potion('hp')], [], { unspentPoints: 3 });
    for (let i = 1; i < intents.length; i++) {
      expect(intents[i - 1]!.priority).toBeGreaterThanOrEqual(intents[i]!.priority);
    }
  });

  it('produces nothing when there is nothing worth doing', () => {
    expect(characterIntents(self(), [], [])).toEqual([]);
  });

  it('converts to Otak candidates the brain can re-rank', () => {
    const intents = characterIntents(self({ hp: 10 }), [potion('hp')], []);
    const cands = intentsToCandidates(intents);
    expect(cands).toHaveLength(intents.length);
    expect(cands[0]!.id).toBe('act:0');
    expect(cands[0]!.label).toContain('potion');
  });

  it('honours a custom survival threshold', () => {
    const strict = { ...DEFAULT_SURVIVAL, healBelow: 0.95 };
    expect(healingIntent(self({ hp: 90 }), [potion('hp')], strict)).not.toBeNull();
  });
});
