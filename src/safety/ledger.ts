/**
 * Append-only value ledger + combat memory.
 *
 * These files are the ONLY liveness signal the watchdog trusts. SLCW taught
 * that "no errors" is not evidence of progress: a refused action can loop
 * forever at zero errors while producing nothing. Progress is therefore
 * defined as "a new row landed in the ledger", never as "nothing threw".
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ValueEventKind = 'loot' | 'sale_listed' | 'sale_settled' | 'gold' | 'kill';

export interface ValueEvent {
  ts: number;
  accountId: string;
  kind: ValueEventKind;
  detail: string;
  /** Realised or expected value in micro-USDC where meaningful. */
  microUsdc?: string;
  gold?: number;
}

function ensureDir(path: string): void {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
}

export class Ledger {
  private readonly path: string;
  /** In-memory index of the last event time per account, for the watchdog. */
  private lastByAccount = new Map<string, number>();

  constructor(dataDir: string, filename = 'ledger.jsonl') {
    this.path = join(dataDir, filename);
    ensureDir(this.path);
    this.hydrate();
  }

  private hydrate(): void {
    if (!existsSync(this.path)) return;
    try {
      const lines = readFileSync(this.path, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as ValueEvent;
          if (e.accountId && typeof e.ts === 'number') {
            const prev = this.lastByAccount.get(e.accountId) ?? 0;
            if (e.ts > prev) this.lastByAccount.set(e.accountId, e.ts);
          }
        } catch {
          /* skip a corrupt line rather than lose the whole ledger */
        }
      }
    } catch {
      /* unreadable ledger must not stop the bot */
    }
  }

  append(event: Omit<ValueEvent, 'ts'> & { ts?: number }): ValueEvent {
    const full: ValueEvent = { ts: event.ts ?? Date.now(), ...event } as ValueEvent;
    appendFileSync(this.path, JSON.stringify(full) + '\n', { mode: 0o600 });
    const prev = this.lastByAccount.get(full.accountId) ?? 0;
    if (full.ts > prev) this.lastByAccount.set(full.accountId, full.ts);
    return full;
  }

  /** Last time this account actually produced value. 0 means never. */
  lastValueAt(accountId: string): number {
    return this.lastByAccount.get(accountId) ?? 0;
  }

  accounts(): string[] {
    return [...this.lastByAccount.keys()];
  }
}

export interface MonsterMemory {
  battles: number;
  wins: number;
  losses: number;
  lastAt: number;
}

/**
 * Per-monster combat statistics. Doubles as the second liveness detector:
 * a rising `battles` count proves the bot is actually fighting.
 */
export class CombatMemory {
  private readonly path: string;
  private data: Record<string, Record<string, MonsterMemory>> = {};

  constructor(dataDir: string, filename = 'combat_memory.json') {
    this.path = join(dataDir, filename);
    ensureDir(this.path);
    if (existsSync(this.path)) {
      try {
        this.data = JSON.parse(readFileSync(this.path, 'utf8'));
      } catch {
        this.data = {};
      }
    }
  }

  record(accountId: string, monster: string, outcome: 'win' | 'loss'): MonsterMemory {
    const perAccount = (this.data[accountId] ??= {});
    const m = (perAccount[monster] ??= { battles: 0, wins: 0, losses: 0, lastAt: 0 });
    m.battles += 1;
    if (outcome === 'win') m.wins += 1;
    else m.losses += 1;
    m.lastAt = Date.now();
    this.flush();
    return m;
  }

  totalBattles(accountId: string): number {
    return Object.values(this.data[accountId] ?? {}).reduce((s, m) => s + m.battles, 0);
  }

  winRate(accountId: string, monster: string): number | null {
    const m = this.data[accountId]?.[monster];
    if (!m || m.battles === 0) return null;
    return m.wins / m.battles;
  }

  forAccount(accountId: string): Record<string, MonsterMemory> {
    return this.data[accountId] ?? {};
  }

  private flush(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch {
      /* a failed flush must not kill the run */
    }
  }
}
