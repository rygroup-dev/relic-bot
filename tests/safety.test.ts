import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ParkRegistry, free } from '../src/safety/park.js';
import { Ledger, CombatMemory } from '../src/safety/ledger.js';
import { Watchdog } from '../src/safety/watchdog.js';
import { classifyRefusal } from '../src/protocol/messages.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relic-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('refusal classification (a benign-looking refusal must still block)', () => {
  it('parks the whole fleet on client_outdated', () => {
    const v = classifyRefusal(new Error('client_outdated'));
    expect(v.scope).toBe('fleet');
    expect(v.needsOperator).toBe(true);
  });

  it('parks only the account on device_busy and banned', () => {
    expect(classifyRefusal('device_busy').scope).toBe('account');
    expect(classifyRefusal('banned').scope).toBe('account');
    expect(classifyRefusal('banned').cooldownMs).toBe(Infinity);
  });

  it('treats rate_limited as a recoverable account park, not a retry storm', () => {
    const v = classifyRefusal('rate_limited');
    expect(v.scope).toBe('account');
    expect(v.cooldownMs).toBeGreaterThan(0);
  });

  it('parks indefinitely on no_character instead of reconnecting forever', () => {
    // Observed live 2026-08-28: a wallet with no game character is refused at
    // join. Retrying can never fix it, so it must stop and ask the operator.
    const v = classifyRefusal('no_character');
    expect(v.kind).toBe('no_character');
    expect(v.scope).toBe('account');
    expect(v.cooldownMs).toBe(Infinity);
    expect(v.needsOperator).toBe(true);
  });

  it('backs off on high_demand instead of retrying into the throttle', () => {
    // Observed live 2026-08-30: 8913 denials in 6h, a flat ~3000/h for 24h.
    // high_demand fell through to the 'unknown' retry verdict, so no park was
    // ever written and every wallet re-walked to the trapdoor 5s later — the
    // fleet manufactured the demand it was refused for. 15 of 20 wallets sat
    // at zero production for 22-37h with zero errors.
    const v = classifyRefusal(new Error('dungeon_denied_high_demand'));
    expect(v.kind).toBe('high_demand');
    // Must be an account park: 'retry' writes no park at all, which is the bug.
    expect(v.scope).toBe('account');
    expect(v.cooldownMs).toBeGreaterThanOrEqual(60_000);
    // Recoverable on its own — a capacity throttle needs no human.
    expect(v.needsOperator).toBe(false);
  });

  it('jitters the high_demand backoff so the fleet does not stampede as one', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 40; i += 1) seen.add(classifyRefusal('high_demand').cooldownMs);
    // A fixed cooldown only moves the synchronised retry burst later.
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('SLCW REGRESSION: free() is the only way to run value work', () => {
  it('runs the body when nothing is parked', async () => {
    const reg = new ParkRegistry();
    const out = await free(reg, 'w1', 'farm', async () => 42);
    expect(out).toEqual({ ran: true, value: 42 });
  });

  it('refuses to run once the account/key is parked', async () => {
    const reg = new ParkRegistry();
    reg.park({ scope: 'account', accountId: 'w1', key: 'farm', reason: 'test', cooldownMs: 60_000 });
    const body = vi.fn(async () => 1);
    const out = await free(reg, 'w1', 'farm', body);
    expect(out.ran).toBe(false);
    expect(body).not.toHaveBeenCalled();
  });

  it('a fleet park blocks every account and every key', async () => {
    const reg = new ParkRegistry();
    reg.park({ scope: 'fleet', key: 'client_outdated', reason: 'outdated', cooldownMs: Infinity });
    for (const acct of ['w1', 'w2', 'w3']) {
      const out = await free(reg, acct, 'anything', async () => 1);
      expect(out.ran).toBe(false);
    }
  });

  it('auto-parks from a thrown refusal instead of looping forever', async () => {
    const reg = new ParkRegistry();
    const body = vi.fn(async () => {
      throw new Error('device_busy');
    });
    const first = await free(reg, 'w1', 'farm', body);
    expect(first.ran).toBe(false);

    // Second attempt must not even call the body.
    const second = await free(reg, 'w1', 'farm', body);
    expect(second.ran).toBe(false);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('expires a park once its cooldown elapses', async () => {
    vi.useFakeTimers();
    try {
      const reg = new ParkRegistry();
      reg.park({ scope: 'account', accountId: 'w1', key: 'farm', reason: 'x', cooldownMs: 1_000 });
      expect((await free(reg, 'w1', 'farm', async () => 1)).ran).toBe(false);
      vi.advanceTimersByTime(1_500);
      expect((await free(reg, 'w1', 'farm', async () => 1)).ran).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rethrows a genuine bug rather than silently parking it', async () => {
    const reg = new ParkRegistry();
    await expect(
      free(reg, 'w1', 'farm', async () => {
        throw new TypeError('undefined is not a function');
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe('SLCW REGRESSION: liveness measured by output, never by error count', () => {
  it('flags an account that throws no errors but produces nothing', () => {
    const ledger = new Ledger(dir);
    const combat = new CombatMemory(dir);
    const wd = new Watchdog(ledger, combat, 10 * 60_000, () => {});

    // Zero errors, zero output. Must still be reported.
    const reports = wd.check(['w1'], Date.now() + 30 * 60_000);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.accountId).toBe('w1');
    expect(reports[0]!.battles).toBe(0);
  });

  it('clears once real value lands in the ledger', () => {
    const ledger = new Ledger(dir);
    const combat = new CombatMemory(dir);
    const wd = new Watchdog(ledger, combat, 10 * 60_000, () => {});

    ledger.append({ accountId: 'w1', kind: 'loot', detail: 'Rusted Blade' });
    expect(wd.check(['w1'])).toHaveLength(0);
  });

  it('persists last-value across a restart', () => {
    const l1 = new Ledger(dir);
    l1.append({ accountId: 'w1', kind: 'sale_listed', detail: 'x', microUsdc: '900000' });
    const l2 = new Ledger(dir);
    expect(l2.lastValueAt('w1')).toBeGreaterThan(0);
  });

  it('survives a corrupt ledger line without losing the rest', () => {
    const l1 = new Ledger(dir);
    l1.append({ accountId: 'w1', kind: 'loot', detail: 'good' });
    require('node:fs').appendFileSync(join(dir, 'ledger.jsonl'), '{not json\n');
    l1.append({ accountId: 'w2', kind: 'loot', detail: 'also good' });
    const l2 = new Ledger(dir);
    expect(l2.lastValueAt('w1')).toBeGreaterThan(0);
    expect(l2.lastValueAt('w2')).toBeGreaterThan(0);
  });

  it('counts battles per monster as the second detector', () => {
    const combat = new CombatMemory(dir);
    combat.record('w1', 'troll', 'win');
    combat.record('w1', 'troll', 'loss');
    expect(combat.totalBattles('w1')).toBe(2);
    expect(combat.winRate('w1', 'troll')).toBe(0.5);
    expect(combat.winRate('w1', 'never-fought')).toBeNull();
  });
});
