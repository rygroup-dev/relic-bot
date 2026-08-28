/**
 * Output-based liveness watchdog.
 *
 * Deliberately does NOT look at error counters. The SLCW incident ("healthy but
 * produces nothing", 10 occurrences) happened precisely because a wallet at
 * zero errors was assumed healthy while producing nothing for 13 hours.
 *
 * The only question asked here is: has this account produced value recently?
 */

import type { Ledger, CombatMemory } from './ledger.js';
import { logger } from '../log.js';

const log = logger('watchdog');

export interface SilenceReport {
  accountId: string;
  lastValueAt: number;
  silentForMs: number;
  battles: number;
}

export type AlertFn = (reports: SilenceReport[]) => void | Promise<void>;

export class Watchdog {
  private timer: NodeJS.Timeout | null = null;
  /** Accounts already alerted on, so we warn once per silent spell. */
  private alerted = new Set<string>();
  /** Wallets that started producing again since the last check. */
  private recovered: string[] = [];

  /** Take the recovery list, so each recovery is reported once. */
  drainRecovered(): string[] {
    const out = this.recovered;
    this.recovered = [];
    return out;
  }

  constructor(
    private readonly ledger: Ledger,
    private readonly combat: CombatMemory,
    private readonly silenceMs: number,
    private readonly alert: AlertFn,
  ) {}

  /** Accounts that have produced nothing for longer than the silence budget. */
  check(accountIds: readonly string[], now = Date.now()): SilenceReport[] {
    const out: SilenceReport[] = [];
    for (const id of accountIds) {
      const last = this.ledger.lastValueAt(id);
      // An account that has never produced is measured from process start.
      const since = last === 0 ? this.startedAt : last;
      const silentFor = now - since;
      if (silentFor >= this.silenceMs) {
        out.push({
          accountId: id,
          lastValueAt: last,
          silentForMs: silentFor,
          battles: this.combat.totalBattles(id),
        });
      } else if (this.alerted.has(id)) {
        // It came back. Saying so closes the loop; otherwise the operator is
        // left assuming the last alarm is still true.
        this.alerted.delete(id);
        this.recovered.push(id);
      }
    }
    return out;
  }

  private startedAt = Date.now();

  start(accountIds: () => readonly string[], intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const reports = this.check(accountIds());
      const fresh = reports.filter((r) => !this.alerted.has(r.accountId));
      if (fresh.length === 0) return;
      for (const r of fresh) {
        this.alerted.add(r.accountId);
        log.error(
          `${r.accountId} has produced NOTHING for ${Math.round(r.silentForMs / 60_000)}m ` +
            `(battles=${r.battles}) — zero errors is not health`,
        );
      }
      void this.alert(fresh);
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
