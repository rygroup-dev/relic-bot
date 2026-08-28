/**
 * Notification policy.
 *
 * A fleet generates a constant stream of events. Forwarding all of it turns
 * Telegram into noise, and noise is worse than silence: a real alert stops
 * being noticed. So events are graded, only the ones worth interrupting a
 * person for are sent, and repeats are collapsed.
 *
 * The bar for sending is: would you want your phone to buzz for this?
 */

export type Severity = 'critical' | 'important' | 'routine' | 'debug';

export type EventKind =
  // critical — money, bans, or the whole fleet stopping
  | 'ban'
  | 'fleet_park'
  | 'sweep_executed'
  | 'suspicious'
  // important — progress worth knowing about
  | 'sale_listed'
  | 'sale_settled'
  | 'level_up'
  | 'rare_drop'
  | 'silence'
  | 'character_created'
  | 'gate_opened'
  // routine — normal operation, not worth a buzz
  | 'account_park'
  | 'loot'
  | 'kill'
  | 'run_finished';

const SEVERITY: Record<EventKind, Severity> = {
  ban: 'critical',
  fleet_park: 'critical',
  sweep_executed: 'critical',
  suspicious: 'critical',

  sale_listed: 'important',
  sale_settled: 'important',
  level_up: 'important',
  rare_drop: 'important',
  silence: 'important',
  character_created: 'important',
  gate_opened: 'important',

  account_park: 'routine',
  loot: 'routine',
  kill: 'routine',
  run_finished: 'routine',
};

const ICON: Record<EventKind, string> = {
  ban: '🚫',
  fleet_park: '🛑',
  sweep_executed: '🧹',
  suspicious: '🚨',
  sale_listed: '🏷️',
  sale_settled: '💰',
  level_up: '⭐',
  rare_drop: '💎',
  silence: '😴',
  character_created: '🎭',
  gate_opened: '🔓',
  account_park: '🅿️',
  loot: '🎁',
  kill: '⚔️',
  run_finished: '🏁',
};

/** Human-readable heading per event kind. */
const LABEL: Record<EventKind, string> = {
  ban: 'Banned',
  fleet_park: 'Fleet stopped',
  sweep_executed: 'Sweep executed',
  suspicious: 'Something looks wrong',
  sale_listed: 'Listed for sale',
  sale_settled: 'Sale settled',
  level_up: 'Level up',
  rare_drop: 'Rare drop',
  silence: 'Producing nothing',
  character_created: 'Wallets joined',
  gate_opened: 'Token gate opened',
  account_park: 'Wallet parked',
  loot: 'Loot',
  kill: 'Kill',
  run_finished: 'Run finished',
};

export function labelOf(kind: EventKind): string {
  return LABEL[kind];
}

export interface NotifyEvent {
  kind: EventKind;
  accountId?: string;
  text: string;
  /** Collapses repeats; defaults to kind + account. */
  dedupeKey?: string;
}

export function severityOf(kind: EventKind): Severity {
  return SEVERITY[kind];
}

export function iconOf(kind: EventKind): string {
  return ICON[kind];
}

export interface NotifierOptions {
  /** Minimum severity that reaches the operator. */
  minSeverity?: Severity;
  /** Window in which an identical event is suppressed. */
  dedupeWindowMs?: number;
  /** Hard ceiling so a storm cannot flood the chat. */
  maxPerHour?: number;
}

const ORDER: Record<Severity, number> = {
  critical: 3,
  important: 2,
  routine: 1,
  debug: 0,
};

/**
 * Decides what actually reaches Telegram.
 *
 * Critical events bypass the hourly cap — being rate-limited out of a ban
 * notice would defeat the point — but they are still deduplicated.
 */
export class Notifier {
  private lastSent = new Map<string, number>();
  private sentTimes: number[] = [];

  constructor(private readonly opts: NotifierOptions = {}) {}

  private get minSeverity(): Severity {
    return this.opts.minSeverity ?? 'important';
  }

  shouldSend(event: NotifyEvent, now = Date.now()): boolean {
    const sev = severityOf(event.kind);
    if (ORDER[sev] < ORDER[this.minSeverity]) return false;

    const key = event.dedupeKey ?? `${event.kind}:${event.accountId ?? '-'}`;
    const window = this.opts.dedupeWindowMs ?? 10 * 60_000;
    const prev = this.lastSent.get(key);
    if (prev !== undefined && now - prev < window) return false;

    if (sev !== 'critical') {
      const cutoff = now - 3_600_000;
      this.sentTimes = this.sentTimes.filter((t) => t > cutoff);
      if (this.sentTimes.length >= (this.opts.maxPerHour ?? 20)) return false;
    }

    this.lastSent.set(key, now);
    this.sentTimes.push(now);
    return true;
  }

  /**
   * Render an event for chat.
   *
   * The wallet is part of the message, not decoration: "reached level 7" is
   * useless across a seventeen-wallet fleet if you cannot tell which hero did
   * it. Kept here so every sink formats identically.
   */
  format(event: NotifyEvent): string {
    const icon = iconOf(event.kind);
    const label = LABEL[event.kind];
    const who = event.accountId ? ` · <b>${event.accountId}</b>` : '';
    return `${icon} <b>${label}</b>${who}\n${event.text}`;
  }
}

/**
 * Heuristics for "something looks off".
 *
 * Deliberately conservative: a false alarm every hour trains the operator to
 * ignore the channel, which is the failure this whole module exists to prevent.
 */
export interface SuspicionInput {
  /** Fraction of recent actions the server refused. */
  refusalRate: number;
  /** Consecutive failed logins across the fleet. */
  authFailures: number;
  /** Wallets producing nothing despite being connected. */
  silentAccounts: number;
  totalAccounts: number;
}

export function detectSuspicious(i: SuspicionInput): string | null {
  if (i.totalAccounts === 0) return null;

  if (i.refusalRate >= 0.8) {
    return `the server is refusing ${Math.round(i.refusalRate * 100)}% of actions — ` +
      `the client may be outdated or the account flagged`;
  }
  if (i.authFailures >= 5) {
    return `${i.authFailures} consecutive login failures — credentials or rate limits`;
  }
  if (i.silentAccounts === i.totalAccounts && i.totalAccounts >= 2) {
    return `every wallet is connected but producing nothing — ` +
      `a protocol change would look exactly like this`;
  }
  return null;
}
