import { describe, it, expect } from 'vitest';
import {
  netAfterFee,
  feeAmount,
  chooseCurrency,
  suggestPrice,
} from '../src/economy/pricing.js';
import { listableItems } from '../src/fleet/account.js';
import type { InventoryItem } from '../src/game/actions.js';

const ONE = 1_000_000n; // 1.000000 in micro-units

describe('marketplace fee — the shipped client, not the docs', () => {
  it('deducts 10% for USDC listings', () => {
    expect(netAfterFee(ONE, 'usdc')).toBe(900_000n);
    expect(feeAmount(ONE, 'usdc')).toBe(100_000n);
  });

  it('deducts 10% for RELIC listings too, despite the docs claiming 5%', () => {
    // The client computes both currencies at 1000 bps. Trusting the published
    // 5% would overstate RELIC proceeds on every single sale.
    expect(netAfterFee(ONE, 'relic')).toBe(900_000n);
    expect(feeAmount(ONE, 'relic')).toBe(100_000n);
  });

  it('gives RELIC no fee advantage at all', () => {
    expect(netAfterFee(ONE, 'relic')).toBe(netAfterFee(ONE, 'usdc'));
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
  it('prefers USDC at the 8% default', () => {
    const c = chooseCurrency({
      priceMicroUsdc: ONE,
      relicVolatilityDiscountPct: 8,
      preference: 'auto',
    });
    // RELIC: 0.90 * 0.92 = 0.828 < USDC 0.90
    expect(c.currency).toBe('usdc');
    expect(c.riskAdjustedNetMicroUsdc).toBe(900_000n);
  });

  it('never crosses over to RELIC while any volatility is assumed', () => {
    // With equal fees there is nothing for RELIC to win on, so any discount
    // above zero makes USDC the better risk-adjusted choice.
    for (const pct of [1, 5, 8, 20]) {
      const c = chooseCurrency({
        priceMicroUsdc: ONE,
        relicVolatilityDiscountPct: pct,
        preference: 'auto',
      });
      expect(c.currency, `at ${pct}%`).toBe('usdc');
    }
  });

  it('only ties with RELIC when the operator assumes no volatility at all', () => {
    const c = chooseCurrency({
      priceMicroUsdc: ONE,
      relicVolatilityDiscountPct: 0,
      preference: 'auto',
    });
    // Equal net; the comparison is strict, so USDC keeps it.
    expect(c.riskAdjustedNetMicroUsdc).toBe(900_000n);
    expect(c.currency).toBe('usdc');
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

describe('the gate and the listing floor are recorded, not guessed', () => {
  it('records the 10,000 RELIC hold as documentation only', async () => {
    const { DOCUMENTED_GATE_HOLD_RELIC } = await import('../src/protocol/endpoints.js');
    expect(DOCUMENTED_GATE_HOLD_RELIC).toBe(10_000);
  });

  it('never uses that figure as a runtime threshold', async () => {
    // The gate endpoint returns only { allowed }. Comparing a local balance
    // against a hardcoded number would silently disagree with the server the
    // day it changes, so nothing may branch on this constant.
    const { execSync } = await import('node:child_process');
    const src = new URL('../src', import.meta.url).pathname;
    const uses = execSync(`grep -rln 'DOCUMENTED_GATE_HOLD_RELIC' ${src} || true`, {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((p) => p.replace(/^.*\/src\//, 'src/'));
    expect(uses).toEqual(['src/protocol/endpoints.ts']);
  });

  it('knows the minimum a listing may be priced at', async () => {
    const { MIN_LISTING_PRICE } = await import('../src/protocol/endpoints.js');
    // $1.00, and 10,000 RELIC at 6 decimals.
    expect(MIN_LISTING_PRICE.usdc).toBe(1_000_000n);
    expect(MIN_LISTING_PRICE.relic).toBe(10_000_000_000n);
  });

  it('explains the $1.00 floor seen across 237 legendary listings', async () => {
    const { MIN_LISTING_PRICE } = await import('../src/protocol/endpoints.js');
    const { expectedValueMicroUsdc } = await import('../src/economy/valuation.js');
    // The observed legendary "median" is exactly the minimum the game allows,
    // so it reflects the floor rather than what buyers were willing to pay.
    expect(expectedValueMicroUsdc('legendary')).toBe(MIN_LISTING_PRICE.usdc);
  });
});

describe('REGRESSION: what actually reaches the marketplace', () => {
  // sellableInventory() used to read `latestState.inventory ?? latestState.items`.
  // The live town schema has neither — its only keys are players, mobs, tick and
  // worldRebirthLevel — so it returned an empty list every time and the bot's one
  // revenue channel had nothing to list even with the gate open. It now reads the
  // parsed s.inv.sync inventory through this function.
  const gear = (over: Partial<InventoryItem> = {}): InventoryItem => ({
    instanceId: 'inst_1',
    name: 'Iron Blade',
    slot: 'weapon',
    rarity: 'epic',
    ilvl: 12,
    consumable: false,
    ...over,
  });

  it('lists spare gear', () => {
    const out = listableItems([gear()]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'instance', instanceId: 'inst_1', slot: 'weapon' });
  });

  it('never lists what the hero is wearing', () => {
    // Listing worn gear strips the hero mid-run — the opposite of the goal.
    expect(listableItems([gear({ equipped: true })])).toEqual([]);
  });

  it('never lists consumables', () => {
    // The potions are the survival budget, not stock.
    expect(
      listableItems([{ itemId: 'pot_hp', name: 'Healing Potion', consumable: true, quantity: 3 }]),
    ).toEqual([]);
  });

  it('skips anything with no instance id, because a listing needs the handle', () => {
    expect(listableItems([{ name: 'Mystery', slot: 'weapon' }])).toEqual([]);
  });
});
