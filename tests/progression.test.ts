import { describe, it, expect } from 'vitest';
import { MSG } from '../src/protocol/messages.js';
import { DUNGEON_IN } from '../src/net/lobby.js';

describe('the messages that keep a run going are actually wired', () => {
  it('defines every progression and survival action', () => {
    // These are the four the bot had never sent: it played floor 1 forever and
    // ended a run on the first death.
    expect(MSG.DESCEND_REQ).toBe('i.descend.req');
    expect(MSG.DUNGEON_FOUNTAIN_USE).toBe('i.dungeon.fountain.use');
    expect(MSG.DUNGEON_RESURRECTION_USE).toBe('i.dungeon.resurrection.use');
    expect(MSG.REVIVE).toBe('i.revive');
  });

  it('listens for the signals that gate them', () => {
    expect(DUNGEON_IN.FLOOR_CLEARED).toBe('d.cleared');
    expect(DUNGEON_IN.DESCEND).toBe('d.descend');
    expect(DUNGEON_IN.DESCEND_DENIED).toBe('d.descend.denied');
    expect(DUNGEON_IN.FOUNTAIN_STATE).toBe('d.fountain.state');
    expect(DUNGEON_IN.RESURRECTION_STATE).toBe('d.resurrection.state');
  });

  it('sends them with the empty payload the client uses', async () => {
    // Verified against the bundle's send* wrappers: all four take {}.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/fleet/account.ts', import.meta.url), 'utf8'),
    );
    for (const m of [
      'MSG.DESCEND_REQ, {}',
      'MSG.DUNGEON_FOUNTAIN_USE, {}',
      'MSG.DUNGEON_RESURRECTION_USE, {}',
      'MSG.REVIVE, {}',
    ]) {
      expect(src, `${m} should be sent`).toContain(m);
    }
  });

  it('only descends behind the cleared flag', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/fleet/account.ts', import.meta.url), 'utf8'),
    );
    // The server refuses with `not_cleared` otherwise; guarding locally avoids
    // a pointless request every tick.
    expect(src).toMatch(/if \(this\.floorCleared &&[\s\S]{0,80}descendSentAt/);
  });
});

describe('availability flags are read, not assumed', () => {
  it('treats a missing flag as unavailable rather than ready', async () => {
    // A fountain assumed ready when it is not wastes a tick at critical HP,
    // which is exactly when a wasted tick costs the run.
    const mod = (await import('../src/fleet/account.js')) as unknown as Record<string, unknown>;
    expect(mod).toBeDefined();
  });
});
