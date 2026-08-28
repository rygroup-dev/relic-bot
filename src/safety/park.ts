/**
 * Park state — the fix for the SLCW failure mode.
 *
 * SLCW history (see memory): parks were *recorded* but 6 of 12 free-value
 * branches returned early without ever *reading* them, so 16 wallets sat
 * silent for 13 hours at zero errors.
 *
 * The fix is structural: value-producing work may only run inside `free()`.
 * `free()` consults park state before invoking the body, so a new branch
 * cannot forget to check — there is no other way to run the work.
 */

import { classifyRefusal, type RefusalVerdict } from '../protocol/messages.js';
import { logger } from '../log.js';

const log = logger('park');

export interface ParkEntry {
  scope: 'fleet' | 'account';
  accountId: string | null;
  key: string;
  reason: string;
  since: number;
  until: number; // Infinity for indefinite
  needsOperator: boolean;
}

export type ParkListener = (entry: ParkEntry) => void;

export class ParkRegistry {
  private entries = new Map<string, ParkEntry>();
  private listeners: ParkListener[] = [];

  onPark(fn: ParkListener): void {
    this.listeners.push(fn);
  }

  private id(scope: 'fleet' | 'account', accountId: string | null, key: string): string {
    return scope === 'fleet' ? `fleet:${key}` : `account:${accountId}:${key}`;
  }

  park(opts: {
    scope: 'fleet' | 'account';
    accountId?: string | null;
    key: string;
    reason: string;
    cooldownMs: number;
    needsOperator?: boolean;
  }): ParkEntry {
    const accountId = opts.accountId ?? null;
    const now = Date.now();
    const entry: ParkEntry = {
      scope: opts.scope,
      accountId,
      key: opts.key,
      reason: opts.reason,
      since: now,
      until: Number.isFinite(opts.cooldownMs) ? now + opts.cooldownMs : Infinity,
      needsOperator: opts.needsOperator ?? false,
    };
    this.entries.set(this.id(opts.scope, accountId, opts.key), entry);
    log.warn(
      `parked ${opts.scope}${accountId ? `/${accountId}` : ''} "${opts.key}": ${opts.reason}` +
        (Number.isFinite(opts.cooldownMs) ? ` for ${Math.round(opts.cooldownMs / 1000)}s` : ' indefinitely'),
    );
    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {
        /* a listener must never break parking */
      }
    }
    return entry;
  }

  /** Park derived from a server refusal, honouring its scope and cooldown. */
  parkFromRefusal(accountId: string, key: string, raw: unknown): ParkEntry | null {
    const v: RefusalVerdict = classifyRefusal(raw);
    if (v.scope === 'retry') return null;
    return this.park({
      scope: v.scope === 'fleet' ? 'fleet' : 'account',
      accountId: v.scope === 'fleet' ? null : accountId,
      key: v.scope === 'fleet' ? v.kind : key,
      reason: `${v.kind}: ${String((raw as Error)?.message ?? raw)}`,
      cooldownMs: v.cooldownMs,
      needsOperator: v.needsOperator,
    });
  }

  /** Active park blocking this account/key, if any. */
  blocking(accountId: string, key: string): ParkEntry | null {
    const now = Date.now();
    for (const [id, e] of this.entries) {
      if (e.until <= now) {
        this.entries.delete(id);
        continue;
      }
      if (e.scope === 'fleet') return e; // a fleet park blocks everything
      if (e.accountId === accountId && e.key === key) return e;
    }
    return null;
  }

  unpark(scope: 'fleet' | 'account', accountId: string | null, key: string): boolean {
    return this.entries.delete(this.id(scope, accountId, key));
  }

  unparkAll(): number {
    const n = this.entries.size;
    this.entries.clear();
    log.info(`cleared ${n} park entr${n === 1 ? 'y' : 'ies'}`);
    return n;
  }

  active(): ParkEntry[] {
    const now = Date.now();
    return [...this.entries.values()].filter((e) => e.until > now);
  }
}

export type FreeOutcome<T> =
  | { ran: true; value: T }
  | { ran: false; parked: ParkEntry };

/**
 * THE ONLY WAY to run a value-producing action.
 *
 * Every free-value branch must go through here. It checks park state before
 * running the body and parks automatically on a refusal, so the "recorded but
 * never read" bug cannot be reintroduced by adding a new branch.
 */
export async function free<T>(
  registry: ParkRegistry,
  accountId: string,
  key: string,
  body: () => Promise<T>,
): Promise<FreeOutcome<T>> {
  const parked = registry.blocking(accountId, key);
  if (parked) return { ran: false, parked };

  try {
    return { ran: true, value: await body() };
  } catch (err) {
    const entry = registry.parkFromRefusal(accountId, key, err);
    if (entry) return { ran: false, parked: entry };
    throw err;
  }
}
