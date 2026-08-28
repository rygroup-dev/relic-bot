import { describe, it, expect, vi } from 'vitest';
import { RateLimiter, isRateLimited } from '../src/net/ratelimit.js';

const refusal = () => new Error('POST /api/auth/verify failed: rate_limited');

describe('recognising server pushback', () => {
  it('spots the shapes the server actually uses', () => {
    expect(isRateLimited(refusal())).toBe(true);
    expect(isRateLimited(new Error('HTTP 429'))).toBe(true);
    expect(isRateLimited('Too Many Requests')).toBe(true);
  });

  it('does not treat an unrelated failure as pushback', () => {
    // Widening the interval on a network blip would punish the fleet for the
    // wrong reason.
    expect(isRateLimited(new Error('ECONNRESET'))).toBe(false);
    expect(isRateLimited(new Error('banned'))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
  });
});

describe('calls are serialised and spaced', () => {
  it('never runs two calls concurrently', async () => {
    const limiter = new RateLimiter('t', { minIntervalMs: 0 });
    let inFlight = 0;
    let maxInFlight = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.run(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
        }, isRateLimited),
      ),
    );
    expect(maxInFlight).toBe(1);
  });

  it('enforces the minimum interval between calls', async () => {
    const limiter = new RateLimiter('t', { minIntervalMs: 40 });
    const started: number[] = [];
    for (let i = 0; i < 3; i++) {
      await limiter.run(async () => {
        started.push(Date.now());
      }, isRateLimited);
    }
    for (let i = 1; i < started.length; i++) {
      expect(started[i]! - started[i - 1]!).toBeGreaterThanOrEqual(35);
    }
  });

  it('keeps ordering stable across concurrent callers', async () => {
    const limiter = new RateLimiter('t', { minIntervalMs: 0 });
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3].map((i) =>
        limiter.run(async () => {
          order.push(i);
        }, isRateLimited),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3]);
  });
});

describe('the interval adapts instead of staying wrong', () => {
  it('widens when the server pushes back', async () => {
    const limiter = new RateLimiter('t', { minIntervalMs: 10, backoffFactor: 3 });
    const before = limiter.currentIntervalMs;
    await expect(
      limiter.run(async () => {
        throw refusal();
      }, isRateLimited),
    ).rejects.toThrow();
    expect(limiter.currentIntervalMs).toBeGreaterThan(before);
    expect(limiter.refusals).toBe(1);
  });

  it('does not widen for an unrelated error', async () => {
    const limiter = new RateLimiter('t', { minIntervalMs: 10 });
    const before = limiter.currentIntervalMs;
    await expect(
      limiter.run(async () => {
        throw new Error('ECONNRESET');
      }, isRateLimited),
    ).rejects.toThrow();
    expect(limiter.currentIntervalMs).toBe(before);
  });

  it('never grows past the ceiling', async () => {
    const limiter = new RateLimiter('t', {
      minIntervalMs: 10,
      maxIntervalMs: 50,
      backoffFactor: 10,
    });
    for (let i = 0; i < 5; i++) {
      await limiter.run(async () => {
        throw refusal();
      }, isRateLimited).catch(() => {});
    }
    expect(limiter.currentIntervalMs).toBeLessThanOrEqual(50);
  });

  it('eases back down after success so a blip is not permanent', async () => {
    const limiter = new RateLimiter('t', {
      minIntervalMs: 1,
      backoffFactor: 8,
      recoveryFactor: 0.5,
    });
    await limiter.run(async () => {
      throw refusal();
    }, isRateLimited).catch(() => {});
    const penalised = limiter.currentIntervalMs;

    await limiter.run(async () => 'ok', isRateLimited);
    expect(limiter.currentIntervalMs).toBeLessThan(penalised);
    expect(limiter.refusals).toBe(0);
  });

  it('can be reset by an operator', async () => {
    const limiter = new RateLimiter('t', { minIntervalMs: 5, backoffFactor: 10 });
    await limiter.run(async () => {
      throw refusal();
    }, isRateLimited).catch(() => {});
    limiter.reset();
    expect(limiter.currentIntervalMs).toBe(5);
    expect(limiter.refusals).toBe(0);
  });

  it('keeps working after a rejection — the queue does not wedge', async () => {
    const limiter = new RateLimiter('t', { minIntervalMs: 0 });
    await limiter.run(async () => {
      throw refusal();
    }, isRateLimited).catch(() => {});
    await expect(limiter.run(async () => 'still works', isRateLimited)).resolves.toBe(
      'still works',
    );
  });
});
