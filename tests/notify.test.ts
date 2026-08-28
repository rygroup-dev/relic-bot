import { describe, it, expect } from 'vitest';
import {
  Notifier,
  severityOf,
  detectSuspicious,
  type NotifyEvent,
} from '../src/safety/notify.js';

const ev = (over: Partial<NotifyEvent> = {}): NotifyEvent => ({
  kind: 'sale_listed',
  text: 'listed something',
  accountId: 'wallet-01',
  ...over,
});

describe('only things worth a buzz get through', () => {
  it('sends money, bans and fleet-wide stops', () => {
    const n = new Notifier();
    for (const kind of ['ban', 'fleet_park', 'sweep_executed', 'suspicious'] as const) {
      expect(severityOf(kind)).toBe('critical');
      expect(n.shouldSend(ev({ kind, accountId: kind }))).toBe(true);
    }
  });

  it('sends progress worth knowing about', () => {
    const n = new Notifier();
    for (const kind of ['sale_listed', 'level_up', 'rare_drop', 'silence'] as const) {
      expect(severityOf(kind)).toBe('important');
      expect(n.shouldSend(ev({ kind, accountId: kind }))).toBe(true);
    }
  });

  it('drops routine chatter — loot and kills would be constant', () => {
    const n = new Notifier();
    for (const kind of ['loot', 'kill', 'account_park', 'run_finished'] as const) {
      expect(severityOf(kind)).toBe('routine');
      expect(n.shouldSend(ev({ kind }))).toBe(false);
    }
  });

  it('can be opened up when an operator wants everything', () => {
    const n = new Notifier({ minSeverity: 'routine' });
    expect(n.shouldSend(ev({ kind: 'loot' }))).toBe(true);
  });
});

describe('repeats are collapsed', () => {
  it('suppresses an identical event inside the window', () => {
    const n = new Notifier({ dedupeWindowMs: 60_000 });
    const now = Date.now();
    expect(n.shouldSend(ev(), now)).toBe(true);
    expect(n.shouldSend(ev(), now + 30_000)).toBe(false);
    expect(n.shouldSend(ev(), now + 61_000)).toBe(true);
  });

  it('treats different accounts as different events', () => {
    const n = new Notifier();
    expect(n.shouldSend(ev({ accountId: 'w1' }))).toBe(true);
    expect(n.shouldSend(ev({ accountId: 'w2' }))).toBe(true);
  });
});

describe('a storm cannot flood the chat', () => {
  it('caps non-critical events per hour', () => {
    const n = new Notifier({ maxPerHour: 3, dedupeWindowMs: 0 });
    let sent = 0;
    for (let i = 0; i < 20; i++) {
      if (n.shouldSend(ev({ accountId: `w${i}` }))) sent += 1;
    }
    expect(sent).toBe(3);
  });

  it('never rate-limits a ban out of existence', () => {
    const n = new Notifier({ maxPerHour: 1, dedupeWindowMs: 0 });
    n.shouldSend(ev({ accountId: 'filler' }));
    // The cap is already spent, but a ban must still arrive.
    expect(n.shouldSend(ev({ kind: 'ban', accountId: 'w9' }))).toBe(true);
  });

  it('still deduplicates critical events', () => {
    const n = new Notifier({ dedupeWindowMs: 60_000 });
    const now = Date.now();
    expect(n.shouldSend(ev({ kind: 'ban', accountId: 'w1' }), now)).toBe(true);
    expect(n.shouldSend(ev({ kind: 'ban', accountId: 'w1' }), now + 1_000)).toBe(false);
  });
});

describe('suspicion detection is deliberately conservative', () => {
  it('stays quiet during normal operation', () => {
    expect(
      detectSuspicious({
        refusalRate: 0.1,
        authFailures: 1,
        silentAccounts: 1,
        totalAccounts: 5,
      }),
    ).toBeNull();
  });

  it('flags a fleet that is connected but producing nothing', () => {
    const s = detectSuspicious({
      refusalRate: 0,
      authFailures: 0,
      silentAccounts: 4,
      totalAccounts: 4,
    });
    expect(s).toMatch(/producing nothing/);
  });

  it('does not flag a single silent wallet as a protocol change', () => {
    expect(
      detectSuspicious({
        refusalRate: 0,
        authFailures: 0,
        silentAccounts: 1,
        totalAccounts: 1,
      }),
    ).toBeNull();
  });

  it('flags mass refusals and repeated auth failure', () => {
    expect(
      detectSuspicious({ refusalRate: 0.9, authFailures: 0, silentAccounts: 0, totalAccounts: 3 }),
    ).toMatch(/refusing/);
    expect(
      detectSuspicious({ refusalRate: 0, authFailures: 6, silentAccounts: 0, totalAccounts: 3 }),
    ).toMatch(/login failures/);
  });

  it('says nothing when there is no fleet', () => {
    expect(
      detectSuspicious({ refusalRate: 1, authFailures: 9, silentAccounts: 0, totalAccounts: 0 }),
    ).toBeNull();
  });
});

describe('the events an operator actually wants to hear about', () => {
  it('sends a level-up, a rare drop and a gate opening', () => {
    const n = new Notifier();
    for (const kind of ['level_up', 'rare_drop', 'gate_opened'] as const) {
      expect(severityOf(kind)).toBe('important');
      expect(n.shouldSend(ev({ kind, accountId: kind }))).toBe(true);
    }
  });

  it('still refuses the constant background noise', () => {
    const n = new Notifier();
    // Loot and kills happen continuously — a rare drop is the signal, an
    // ordinary drop is the noise that would bury it.
    expect(n.shouldSend(ev({ kind: 'loot' }))).toBe(false);
    expect(n.shouldSend(ev({ kind: 'kill' }))).toBe(false);
  });

  it('does not let one wallet levelling repeatedly flood the chat', () => {
    const n = new Notifier({ dedupeWindowMs: 10 * 60_000 });
    const now = Date.now();
    expect(n.shouldSend(ev({ kind: 'level_up', accountId: 'w1' }), now)).toBe(true);
    expect(n.shouldSend(ev({ kind: 'level_up', accountId: 'w1' }), now + 60_000)).toBe(false);
    // A different wallet is still worth hearing.
    expect(n.shouldSend(ev({ kind: 'level_up', accountId: 'w2' }), now + 60_000)).toBe(true);
  });
});
