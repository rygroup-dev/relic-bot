import { describe, it, expect } from 'vitest';
import {
  netAfterFee,
  feeAmount,
  chooseCurrency,
  suggestPrice,
} from '../src/economy/pricing.js';

const ONE = 1_000_000n; // 1.000000 in micro-units

describe('marketplace fee (docs: 10% USDC / 5% RELIC, seller-paid)', () => {
  it('deducts 10% for USDC listings', () => {
    expect(netAfterFee(ONE, 'usdc')).toBe(900_000n);
    expect(feeAmount(ONE, 'usdc')).toBe(100_000n);
  });

  it('deducts 5% for RELIC listings', () => {
    expect(netAfterFee(ONE, 'relic')).toBe(950_000n);
    expect(feeAmount(ONE, 'relic')).toBe(50_000n);
  });

  it('never returns more than the price, and never negative', () => {
    for (const p of [0n, 1n, 7n, 999n, 12_345_678n]) {
      for (const c of ['usdc', 'relic'] as const) {
        const net = netAfterFee(p, c);
        expect(net).toBeLessThanOrEqual(p);
        expect(net).toBeGreaterThanOrEqual(0n);
        expect(net + feeAmount(p, c)).toBe(p);
      }
    }
  });

  it('rejects negative prices', () => {
    expect(() => netAfterFee(-1n, 'usdc')).toThrow(RangeError);
  });
});

describe('currency choice is risk-adjusted, not naive', () => {
  it('prefers USDC at the conservative 8% default despite the lower fee on RELIC', () => {
    const c = chooseCurrency({
      priceMicroUsdc: ONE,
      relicVolatilityDiscountPct: 8,
      preference: 'auto',
    });
    // RELIC: 0.95 * 0.92 = 0.874 < USDC 0.90
    expect(c.currency).toBe('usdc');
    expect(c.riskAdjustedNetMicroUsdc).toBe(900_000n);
  });

  it('crosses over to RELIC once the discount falls below ~5.26%', () => {
    const c = chooseCurrency({
      priceMicroUsdc: ONE,
      relicVolatilityDiscountPct: 5,
      preference: 'auto',
    });
    // RELIC: 0.95 * 0.95 = 0.9025 > USDC 0.90
    expect(c.currency).toBe('relic');
    expect(c.riskAdjustedNetMicroUsdc).toBe(902_500n);
  });

  it('treats RELIC as strictly better when the operator assumes no volatility', () => {
    const c = chooseCurrency({
      priceMicroUsdc: ONE,
      relicVolatilityDiscountPct: 0,
      preference: 'auto',
    });
    expect(c.currency).toBe('relic');
    expect(c.riskAdjustedNetMicroUsdc).toBe(950_000n);
  });

  it('honours an explicit operator override', () => {
    const c = chooseCurrency({
      priceMicroUsdc: ONE,
      relicVolatilityDiscountPct: 0,
      preference: 'usdc',
    });
    expect(c.currency).toBe('usdc');
    expect(c.reason).toMatch(/override/);
  });

  it('clamps nonsense discounts instead of producing negative proceeds', () => {
    const c = chooseCurrency({
      priceMicroUsdc: ONE,
      relicVolatilityDiscountPct: 500,
      preference: 'relic',
    });
    expect(c.riskAdjustedNetMicroUsdc).toBeGreaterThanOrEqual(0n);
  });
});

describe('price suggestion', () => {
  const base = {
    minNetMicroUsdc: 0n,
    relicVolatilityDiscountPct: 8,
    preference: 'auto' as const,
  };

  it('refuses to guess with no comparables', () => {
    expect(suggestPrice([], base)).toBeNull();
  });

  it('undercuts the cheapest comparable by 3%', () => {
    const s = suggestPrice(
      [
        { priceMicroUsdc: 10_000_000n, currency: 'usdc' },
        { priceMicroUsdc: 12_000_000n, currency: 'usdc' },
      ],
      base,
    );
    expect(s).not.toBeNull();
    expect(s!.priceMicroUsdc).toBe(9_700_000n);
    expect(s!.comparableCount).toBe(2);
  });

  it('declines to list when net proceeds fall under the operator floor', () => {
    const s = suggestPrice([{ priceMicroUsdc: 10_000n, currency: 'usdc' }], {
      ...base,
      minNetMicroUsdc: 50_000n,
    });
    expect(s).toBeNull();
  });

  it('declines on a zero-priced comparable rather than listing for free', () => {
    expect(suggestPrice([{ priceMicroUsdc: 0n, currency: 'usdc' }], base)).toBeNull();
  });
});
