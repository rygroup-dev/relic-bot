/**
 * Listing price and currency selection.
 *
 * Fee model, taken from the shipped client rather than the docs.
 *
 * The docs claim 10% for USDC and 5% for RELIC. The deployed client computes
 * both at 1000 bps — 10% either way (see MARKETPLACE_FEE_BPS). RELIC therefore
 * carries NO fee advantage, and since it is a volatile pump.fun asset against
 * a stablecoin, USDC is strictly better unless the operator actively wants
 * RELIC exposure.
 *
 * The volatility discount is kept because it still expresses that preference,
 * but it no longer has 5 percentage points of fee saving to overcome.
 *
 * All money is integer micro-units (1e-6). No floating point is ever used to
 * carry a monetary amount.
 */

import { MARKETPLACE_FEE_BPS, type Currency } from '../protocol/endpoints.js';

const BPS = 10_000n;

/** Net proceeds to the seller after the marketplace fee, in micro-units. */
export function netAfterFee(priceMicro: bigint, currency: Currency): bigint {
  if (priceMicro < 0n) throw new RangeError('price must be non-negative');
  const feeBps = BigInt(MARKETPLACE_FEE_BPS[currency]);
  const fee = (priceMicro * feeBps) / BPS;
  return priceMicro - fee;
}

/** The fee itself, in micro-units. */
export function feeAmount(priceMicro: bigint, currency: Currency): bigint {
  return priceMicro - netAfterFee(priceMicro, currency);
}

export interface CurrencyChoice {
  currency: Currency;
  /** Risk-adjusted net proceeds, expressed in micro-USDC. */
  riskAdjustedNetMicroUsdc: bigint;
  reason: string;
}

export interface CurrencyInputs {
  /** Target sale price in micro-USDC (the value we want to realise). */
  priceMicroUsdc: bigint;
  /**
   * Discount applied to RELIC proceeds to account for price volatility and
   * exit slippage, in percent. 0 means "treat RELIC as good as USDC".
   */
  relicVolatilityDiscountPct: number;
  /** Operator override; 'auto' runs the comparison. */
  preference: 'auto' | Currency;
}

/**
 * Choose the listing currency that maximises risk-adjusted proceeds.
 *
 * Worked example at the 8% default:
 *   USDC : 1.000000 * 0.90              = 0.900000
 *   RELIC: 1.000000 * 0.95 * (1 - 0.08) = 0.874000  -> USDC wins
 * At a 5% discount RELIC wins (0.902500), which is the intended crossover.
 */
export function chooseCurrency(inp: CurrencyInputs): CurrencyChoice {
  const { priceMicroUsdc, relicVolatilityDiscountPct, preference } = inp;

  const netUsdc = netAfterFee(priceMicroUsdc, 'usdc');

  const discountBps = BigInt(Math.round(clampPct(relicVolatilityDiscountPct) * 100));
  const netRelicRaw = netAfterFee(priceMicroUsdc, 'relic');
  const netRelicAdj = (netRelicRaw * (BPS - discountBps)) / BPS;

  if (preference !== 'auto') {
    return {
      currency: preference,
      riskAdjustedNetMicroUsdc: preference === 'usdc' ? netUsdc : netRelicAdj,
      reason: `operator override: ${preference}`,
    };
  }

  if (netRelicAdj > netUsdc) {
    return {
      currency: 'relic',
      riskAdjustedNetMicroUsdc: netRelicAdj,
      reason:
        `RELIC nets ${fmt(netRelicAdj)} after 5% fee and ` +
        `${relicVolatilityDiscountPct}% volatility discount, vs USDC ${fmt(netUsdc)} after 10% fee`,
    };
  }
  return {
    currency: 'usdc',
    riskAdjustedNetMicroUsdc: netUsdc,
    reason:
      `USDC nets ${fmt(netUsdc)} after 10% fee, vs RELIC ${fmt(netRelicAdj)} ` +
      `after 5% fee and ${relicVolatilityDiscountPct}% volatility discount`,
  };
}

function clampPct(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(100, Math.max(0, p));
}

function fmt(micro: bigint): string {
  const neg = micro < 0n;
  const v = neg ? -micro : micro;
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

export interface Comparable {
  priceMicroUsdc: bigint;
  currency: Currency;
}

export interface PriceSuggestion {
  priceMicroUsdc: bigint;
  currency: Currency;
  netMicroUsdc: bigint;
  comparableCount: number;
  reason: string;
}

/**
 * Suggest a listing price from live comparables.
 *
 * Strategy: undercut the cheapest comparable slightly so the item actually
 * sells, but never below the floor the operator configured. With no
 * comparables we refuse to guess and return null — a bad price on a real-money
 * marketplace is worse than not listing.
 */
export function suggestPrice(
  comparables: readonly Comparable[],
  opts: {
    undercutBps?: number;
    minNetMicroUsdc: bigint;
    relicVolatilityDiscountPct: number;
    preference: 'auto' | Currency;
  },
): PriceSuggestion | null {
  if (comparables.length === 0) return null;

  const undercutBps = BigInt(opts.undercutBps ?? 300); // 3% below the floor
  const floor = comparables.reduce(
    (min, c) => (c.priceMicroUsdc < min ? c.priceMicroUsdc : min),
    comparables[0]!.priceMicroUsdc,
  );
  if (floor <= 0n) return null;

  const price = (floor * (BPS - undercutBps)) / BPS;
  const choice = chooseCurrency({
    priceMicroUsdc: price,
    relicVolatilityDiscountPct: opts.relicVolatilityDiscountPct,
    preference: opts.preference,
  });

  if (choice.riskAdjustedNetMicroUsdc < opts.minNetMicroUsdc) return null;

  return {
    priceMicroUsdc: price,
    currency: choice.currency,
    netMicroUsdc: choice.riskAdjustedNetMicroUsdc,
    comparableCount: comparables.length,
    reason:
      `undercut floor ${fmt(floor)} by ${Number(undercutBps) / 100}% ` +
      `across ${comparables.length} comparable(s); ${choice.reason}`,
  };
}
