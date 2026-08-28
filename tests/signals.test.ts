import { describe, it, expect } from 'vitest';
import { SignalState, SIG, VALUE_SIGNALS } from '../src/net/signals.js';

const ME = 'my-session';

describe('inventory arrives on a signal, not in room state', () => {
  it('populates from s.inv.sync', () => {
    const s = new SignalState();
    s.apply(SIG.INV_SYNC, {
      items: [
        { instanceId: 'i1', name: 'Health Potion', consumable: true, quantity: 3 },
        { instanceId: 'i2', name: 'Iron Blade', slot: 'weapon', rarity: 'epic' },
      ],
    }, ME);
    expect(s.inventory).toHaveLength(2);
    expect(s.inventory[0]!.name).toBe('Health Potion');
    expect(s.inventory[1]!.slot).toBe('weapon');
  });

  it('accepts the alternative field names without inventing data', () => {
    const s = new SignalState();
    s.apply(SIG.INV_SYNC, { inventory: [{ itemId: 'x', name: 'Thing' }] }, ME);
    expect(s.inventory).toHaveLength(1);
  });

  it('ignores a malformed sync rather than clearing what it knows', () => {
    const s = new SignalState();
    s.apply(SIG.INV_SYNC, { items: [{ name: 'Keeper' }] }, ME);
    s.apply(SIG.INV_SYNC, { nonsense: true }, ME);
    expect(s.inventory).toHaveLength(1);
  });

  it('drops entries with no usable name', () => {
    const s = new SignalState();
    s.apply(SIG.INV_SYNC, { items: [{}, { name: 'Real' }] }, ME);
    expect(s.inventory.map((i) => i.name)).toEqual(['Real']);
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
    s.apply(SIG.INV_SYNC, { items: [{ name: 'Potion' }] }, ME);
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
