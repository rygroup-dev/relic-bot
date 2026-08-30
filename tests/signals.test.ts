import { describe, it, expect } from 'vitest';
import { SignalState, SIG, VALUE_SIGNALS } from '../src/net/signals.js';

const ME = 'my-session';

describe('inventory arrives on a signal, not in room state', () => {
  // Real `s.inv.sync` payload, captured from a live dungeon 2026-08-30:
  //   { gold, pxp, capacity, instances[], stacks[], stashInstances[],
  //     stashStacks[], containers{}, artifactPointsAvailable, ... }
  //
  // The tests below used to assert an `items: [{ instanceId, consumable }]`
  // shape that the server never sends. They passed while the parser matched
  // nothing on the live server, so the bag was empty for the bot's whole life
  // and every potion/equip/sell decision was dead code. Fixtures are now the
  // observed shape.
  const gear = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'inst_1',
    defId: 'sword_iron',
    name: 'Iron Blade',
    rarity: 'epic',
    slot: 'weapon',
    classId: 'knight',
    ilvl: 12,
    levelReq: 5,
    state: 'inventory',
    equippedSlot: -1,
    ...over,
  });

  const stack = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    itemId: 'pot_hp',
    name: 'Health Potion',
    rarity: 'common',
    quantity: 3,
    soulbound: false,
    ...over,
  });

  it('parses instances and stacks from the real payload', () => {
    const s = new SignalState();
    s.apply(SIG.INV_SYNC, { gold: 500, capacity: 40, instances: [gear()], stacks: [stack()] }, ME);

    expect(s.inventory).toHaveLength(2);
    const blade = s.inventory.find((i) => i.name === 'Iron Blade')!;
    // `id` is the instance handle, NOT `instanceId` — i.inv.equip needs it.
    expect(blade.instanceId).toBe('inst_1');
    expect(blade.slot).toBe('weapon');
    expect(blade.ilvl).toBe(12);
    expect(blade.levelReq).toBe(5);
    expect(blade.consumable).toBe(false);

    const potion = s.inventory.find((i) => i.name === 'Health Potion')!;
    expect(potion.itemId).toBe('pot_hp');
    expect(potion.quantity).toBe(3);
    // No `consumable` flag exists server-side; it is inferred from the name.
    expect(potion.consumable).toBe(true);
  });

  it('reads gold and capacity off the same sync', () => {
    const s = new SignalState();
    s.apply(SIG.INV_SYNC, { gold: 1234, capacity: 40, instances: [], stacks: [] }, ME);
    expect(s.gold).toBe(1234);
    expect(s.capacity).toBe(40);
  });

  it('detects worn gear from state or equippedSlot, not an equipped boolean', () => {
    const s = new SignalState();
    s.apply(
      SIG.INV_SYNC,
      {
        instances: [
          gear({ id: 'a', state: 'equipped', equippedSlot: -1 }),
          gear({ id: 'b', state: 'inventory', equippedSlot: 2 }),
          gear({ id: 'c', state: 'inventory', equippedSlot: -1 }),
        ],
        stacks: [],
      },
      ME,
    );
    const byId = new Map(s.inventory.map((i) => [i.instanceId, i]));
    // Both signals must count: treating worn gear as spare would make the bot
    // re-equip or list what it is wearing.
    expect(byId.get('a')!.equipped).toBe(true);
    expect(byId.get('b')!.equipped).toBe(true);
    expect(byId.get('c')!.equipped).toBe(false);
  });

  it('ignores a sync carrying neither array rather than clearing the bag', () => {
    const s = new SignalState();
    s.apply(SIG.INV_SYNC, { instances: [gear()], stacks: [] }, ME);
    s.apply(SIG.INV_SYNC, { nonsense: true }, ME);
    expect(s.inventory).toHaveLength(1);
  });

  it('drops elements missing the id the server needs to act on them', () => {
    const s = new SignalState();
    s.apply(
      SIG.INV_SYNC,
      {
        // No `id` — unusable for i.inv.equip. No `name` — unusable for pricing.
        instances: [{ name: 'Nameless' }, gear({ id: 'ok', name: 'Real Blade' })],
        stacks: [{ quantity: 1 }, stack({ itemId: 'ok_pot', name: 'Real Potion' })],
      },
      ME,
    );
    expect(s.inventory.map((i) => i.name).sort()).toEqual(['Real Blade', 'Real Potion']);
  });

  it('excludes the stash: it is town storage and cannot be used mid-run', () => {
    const s = new SignalState();
    s.apply(
      SIG.INV_SYNC,
      {
        instances: [gear()],
        stacks: [],
        stashInstances: [gear({ id: 'stashed', name: 'Stashed Blade' })],
        stashStacks: [stack({ itemId: 'stashed_pot', name: 'Stashed Potion' })],
      },
      ME,
    );
    expect(s.inventory.map((i) => i.name)).toEqual(['Iron Blade']);
  });
});

describe('value tracking', () => {
  it('accumulates gold gained across a run', () => {
    const s = new SignalState();
    s.apply(SIG.LOOT_GOLD, { amount: 12 }, ME);
    s.apply(SIG.LOOT_GOLD, { amount: 8, total: 20 }, ME);
    expect(s.goldGained).toBe(20);
    expect(s.gold).toBe(20);
  });

  it('accumulates xp from both xp signals', () => {
    const s = new SignalState();
    s.apply(SIG.COMBAT_XP, { amount: 5 }, ME);
    s.apply(SIG.LOOT_PXP, { amount: 7 }, ME);
    expect(s.xpGained).toBe(12);
  });

  it('reads level and the running gold total off s.combat.xp', () => {
    const s = new SignalState();
    // Real payload: { amount, xp, level, gold, leveledUp }. `level` and `gold`
    // were both ignored, and s.loot.gold carries no running total at all
    // (its real shape is { amount, col, row, big, golden }), so the bot never
    // knew its own gold or level from the signal stream.
    s.apply(SIG.COMBAT_XP, { amount: 5, xp: 120, level: 7, gold: 940, leveledUp: false }, ME);
    expect(s.level).toBe(7);
    expect(s.gold).toBe(940);
  });

  it('latches a level-up and hands it over exactly once', () => {
    const s = new SignalState();
    s.apply(SIG.COMBAT_XP, { amount: 5, level: 7, leveledUp: true }, ME);
    // Drained, not read: a level-up grants attribute points, and the spend must
    // happen once — not on every tick that follows.
    expect(s.takeLevelUp()).toBe(true);
    expect(s.takeLevelUp()).toBe(false);
  });

  it('infers a level-up from a rising level even without the flag', () => {
    const s = new SignalState();
    s.apply(SIG.COMBAT_XP, { amount: 1, level: 5 }, ME);
    expect(s.takeLevelUp()).toBe(false);
    s.apply(SIG.COMBAT_XP, { amount: 1, level: 6 }, ME);
    expect(s.takeLevelUp()).toBe(true);
  });

  it('ignores a non-numeric amount instead of counting it as zero', () => {
    const s = new SignalState();
    s.apply(SIG.LOOT_GOLD, { amount: 'lots' }, ME);
    expect(s.goldGained).toBe(0);
    expect(s.gold).toBeNull();
  });

  it('lists exactly the signals worth a ledger row', () => {
    expect([...VALUE_SIGNALS].sort()).toEqual(
      [SIG.COMBAT_XP, SIG.LOOT_GOLD, SIG.LOOT_PXP].sort(),
    );
  });
});

describe('cooldowns come from the server, not a guess', () => {
  it('marks an ability busy for the stated duration', () => {
    const s = new SignalState();
    s.apply(SIG.CD_SET, { abilityId: 'nova', ms: 10_000 }, ME);
    expect(s.abilityReady('nova')).toBe(false);
    expect(s.abilityReady('nova', Date.now() + 11_000)).toBe(true);
  });

  it('accepts an absolute readyAt', () => {
    const s = new SignalState();
    const at = Date.now() + 5_000;
    s.apply(SIG.CD_SET, { abilityId: 'strike', readyAt: at }, ME);
    expect(s.cooldownReadyAt('strike')).toBe(at);
  });

  it('shortens a cooldown on reduction, never past now', () => {
    const s = new SignalState();
    s.apply(SIG.CD_SET, { abilityId: 'nova', ms: 10_000 }, ME);
    s.apply(SIG.CD_REDUCE, { abilityId: 'nova', ms: 999_999 }, ME);
    expect(s.abilityReady('nova')).toBe(true);
  });

  it('treats an unseen ability as ready rather than blocked', () => {
    expect(new SignalState().abilityReady('never-seen')).toBe(true);
  });
});

describe('survival signals', () => {
  it('flags only our own death', () => {
    const s = new SignalState();
    s.apply(SIG.DEATH, { id: 'someone-else' }, ME);
    expect(s.dead).toBe(false);
    s.apply(SIG.DEATH, { id: ME }, ME);
    expect(s.dead).toBe(true);
  });

  it('clears on respawn', () => {
    const s = new SignalState();
    s.apply(SIG.DEATH, { id: ME }, ME);
    s.apply(SIG.RESPAWN, {}, ME);
    expect(s.dead).toBe(false);
  });

  it('reports a telegraph only while it is still relevant', () => {
    const s = new SignalState();
    expect(s.underTelegraph()).toBe(false);
    s.apply(SIG.TELEGRAPH, {}, ME);
    expect(s.underTelegraph()).toBe(true);
    expect(s.underTelegraph(1_200, Date.now() + 5_000)).toBe(false);
  });

  it('clears a telegraph when the server cancels it', () => {
    const s = new SignalState();
    s.apply(SIG.TELEGRAPH, {}, ME);
    s.apply(SIG.TELEGRAPH_CANCEL, {}, ME);
    expect(s.underTelegraph()).toBe(false);
  });

  it('captures the resync position from a denied move, once', () => {
    const s = new SignalState();
    s.apply(SIG.MOVE_DENIED, { col: 4, row: 9 }, ME);
    expect(s.takeResync()).toEqual({ col: 4, row: 9 });
    expect(s.takeResync()).toBeNull();
  });
});

describe('run lifecycle', () => {
  it('resets per-run counters but keeps inventory', () => {
    const s = new SignalState();
    s.apply(SIG.INV_SYNC, { stacks: [{ itemId: 'pot', name: 'Potion', quantity: 1 }] }, ME);
    s.apply(SIG.LOOT_GOLD, { amount: 50 }, ME);
    s.apply(SIG.DEATH, { id: ME }, ME);
    s.resetRun();
    expect(s.goldGained).toBe(0);
    expect(s.dead).toBe(false);
    expect(s.inventory).toHaveLength(1);
  });

  it('ignores unknown signal types silently', () => {
    const s = new SignalState();
    expect(() => s.apply('s.something.new', { x: 1 }, ME)).not.toThrow();
  });
});

describe('kills are counted from the only evidence there is', () => {
  it('counts a mob death as a kill, not as our own', () => {
    const s = new SignalState();
    s.apply(SIG.DEATH, { id: 'mob-7', name: 'Ghoul' }, ME);
    expect(s.dead).toBe(false);
    expect(s.drainKills()).toEqual(['Ghoul']);
  });

  it('does not count our own death as a kill', () => {
    const s = new SignalState();
    s.apply(SIG.DEATH, { id: ME }, ME);
    expect(s.drainKills()).toEqual([]);
    expect(s.dead).toBe(true);
  });

  it('drains so each kill is counted exactly once', () => {
    const s = new SignalState();
    s.apply(SIG.DEATH, { id: 'a', name: 'Rat' }, ME);
    s.apply(SIG.DEATH, { id: 'b', name: 'Rat' }, ME);
    expect(s.drainKills()).toHaveLength(2);
    expect(s.drainKills()).toHaveLength(0);
  });

  it('falls back to a placeholder rather than dropping an unnamed kill', () => {
    const s = new SignalState();
    s.apply(SIG.DEATH, { id: 'mob-9' }, ME);
    expect(s.drainKills()).toEqual(['unknown']);
  });

  it('clears kills between runs', () => {
    const s = new SignalState();
    s.apply(SIG.DEATH, { id: 'a', name: 'Rat' }, ME);
    s.resetRun();
    expect(s.drainKills()).toEqual([]);
  });
});
