/**
 * Shared rate limiter for the authentication endpoint.
 *
 * `/api/auth/verify` limits aggressively, and the limit is shared across the
 * whole fleet rather than per wallet. Spacing wallet *starts* is not enough:
 * reconnects, restarts and park expiries all produce bursts that no start
 * schedule accounts for.
 *
 * So every login in the process funnels through one gate that
 *   - serialises calls (never two in flight at once),
 *   - enforces a minimum interval between them, and
 *   - widens that interval when the server pushes back, then slowly recovers.
 *
 * The adaptive part matters: a fixed delay guessed too low keeps the fleet in a
 * permanent penalty box, which is exactly what happened during development.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { logger } from '../log.js';

const log = logger('ratelimit');

export interface LimiterOptions {
  /** Floor between two calls when the server is happy. */
  minIntervalMs?: number;
  /** Ceiling the backoff may grow to. */
  maxIntervalMs?: number;
  /** Multiplier applied on each refusal. */
  backoffFactor?: number;
  /** Fraction of the penalty shed after each success. */
  recoveryFactor?: number;
}

export class RateLimiter {
  private queue: Promise<void> = Promise.resolve();
  private lastCall = 0;
  private interval: number;
  private readonly min: number;
  private readonly max: number;
  private readonly up: number;
  private readonly down: number;
  private consecutiveRefusals = 0;

  constructor(
    private readonly name: string,
    opts: LimiterOptions = {},
  ) {
    this.min = opts.minIntervalMs ?? 8_000;
    this.max = opts.maxIntervalMs ?? 180_000;
    this.up = opts.backoffFactor ?? 2;
    this.down = opts.recoveryFactor ?? 0.75;
    this.interval = this.min;
  }

  /** Current spacing, exposed for status views and tests. */
  get currentIntervalMs(): number {
    return this.interval;
  }

  get refusals(): number {
    return this.consecutiveRefusals;
  }

  /**
   * Run `fn` under the gate.
   *
   * `isRefusal` decides whether a thrown error counts as the server pushing
   * back — a network blip should not widen the interval, a 429 should.
   */
  async run<T>(fn: () => Promise<T>, isRefusal: (err: unknown) => boolean): Promise<T> {
    // The whole operation is chained onto the queue, not just the wait: chaining
    // only the delay lets every caller proceed the moment its timer elapses,
    // which serialises nothing at all.
    const result = this.queue.then(async () => {
      await this.waitTurn();
      try {
        const value = await fn();
        this.onSuccess();
        return value;
      } catch (err) {
        if (isRefusal(err)) this.onRefusal();
        throw err;
      } finally {
        this.lastCall = Date.now();
      }
    });

    // The queue must survive a rejected call, or one failure wedges every
    // caller behind it forever.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async waitTurn(): Promise<void> {
    const since = Date.now() - this.lastCall;
    const wait = this.interval - since;
    if (wait > 0) await sleep(wait);
  }

  private onSuccess(): void {
    this.consecutiveRefusals = 0;
    if (this.interval > this.min) {
      const next = Math.max(this.min, Math.round(this.interval * this.down));
      if (next !== this.interval) {
        this.interval = next;
        log.debug(`${this.name}: easing to ${Math.round(this.interval / 1000)}s`);
      }
    }
  }

  private onRefusal(): void {
    this.consecutiveRefusals += 1;
    const next = Math.min(this.max, Math.round(this.interval * this.up));
    if (next !== this.interval) {
      this.interval = next;
      log.warn(
        `${this.name}: server pushed back (${this.consecutiveRefusals} in a row), ` +
          `spacing calls ${Math.round(this.interval / 1000)}s apart`,
      );
    }
  }

  /** Reset after an operator intervention. */
  reset(): void {
    this.interval = this.min;
    this.consecutiveRefusals = 0;
  }
}

export function isRateLimited(err: unknown): boolean {
  const m = String((err as { message?: unknown } | null)?.message ?? err ?? '');
  return /rate_limit|429|too many requests/i.test(m);
}

/**
 * The process-wide auth gate.
 *
 * Deliberately a module singleton: the limit belongs to the server, not to any
 * one client object, so every AuthClient in the process must share it.
 */
export const authLimiter = new RateLimiter('auth', {
  minIntervalMs: Number(process.env.AUTH_MIN_INTERVAL_MS ?? 8_000),
  maxIntervalMs: Number(process.env.AUTH_MAX_INTERVAL_MS ?? 180_000),
});
