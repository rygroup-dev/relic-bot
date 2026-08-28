/**
 * Item valuation, calibrated against the live marketplace on 2026-08-28.
 *
 * Sample: 400 listings, cross-referenced against the 493-item table recovered
 * from the client bundle.
 *
 *   rarity      n     median    max
 *   mythic      23    $10.00    $35.00
 *   cosmetic     5    $12.00    $20.00
 *   legendary  237     $1.00    $11.00
 *   epic        18     $1.00     $2.00
 *
 * Two findings drive everything here:
 *
 * 1. Price tracks RARITY TIER, not drop depth. Median price was $1.00 at every
 *    wave from 2 to 6, so "deeper dungeon = more valuable loot" is false. Do
 *    not sort loot by depth.
 *
 * 2. Legendaries are a $1 commodity — 237 of 283 USDC listings. A legendary
 *    nets $0.90 after the 10% fee, so it is volume, not profit. Mythics carry
 *    roughly 10x the median and are where the money actually is.
 */

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic' | 'cosmetic';

/** Observed median USDC price in micro-units. Unknown rarities score lowest. */
export const MEDIAN_MICRO_USDC: Record<Rarity, bigint> = {
  common: 200_000n,
  uncommon: 300_000n,
  rare: 500_000n,
  epic: 1_000_000n,
  legendary: 1_000_000n,
  cosmetic: 12_000_000n,
  mythic: 10_000_000n,
};

/** Highest observed price, used to sanity-check an outlier ask. */
export const MAX_OBSERVED_MICRO_USDC: Record<Rarity, bigint> = {
  common: 500_000n,
  uncommon: 1_000_000n,
  rare: 2_000_000n,
  epic: 2_000_000n,
  legendary: 11_000_000n,
  cosmetic: 20_000_000n,
  mythic: 35_000_000n,
};

export function normaliseRarity(raw: string | null | undefined): Rarity | null {
  if (!raw) return null;
  const r = raw.toLowerCase().trim();
  return r in MEDIAN_MICRO_USDC ? (r as Rarity) : null;
}

/**
 * Expected sale value before fees, from rarity alone.
 *
 * Returns null for an unrecognised rarity rather than guessing — an invented
 * price on a real-money marketplace is worse than not listing.
 */
export function expectedValueMicroUsdc(rarity: string | null | undefined): bigint | null {
  const r = normaliseRarity(rarity);
  return r === null ? null : MEDIAN_MICRO_USDC[r];
}

/**
 * Loot priority, 0..1. Used to rank drops when several are in reach.
 *
 * Deliberately derived from observed price rather than from a hand-written
 * opinion about which items feel good.
 */
export function lootPriority(rarity: string | null | undefined): number {
  const v = expectedValueMicroUsdc(rarity);
  if (v === null) return 0.3; // unknown: worth grabbing, not worth prioritising
  const max = MEDIAN_MICRO_USDC.cosmetic;
  const ratio = Number(v) / Number(max);
  return Math.min(1, Math.max(0.05, ratio));
}

/** True when an item is worth the round trip of listing it. */
export function worthListing(rarity: string | null | undefined, minNetMicroUsdc: bigint): boolean {
  const v = expectedValueMicroUsdc(rarity);
  if (v === null) return false;
  // Net of the 10% USDC marketplace fee.
  return (v * 90n) / 100n >= minNetMicroUsdc;
}

/**
 * Flag an ask that is far outside anything observed for its tier.
 *
 * Cuts both ways: a mythic listed at the $1 legendary floor is very likely a
 * mispriced bargain, and an ask far above the observed maximum will never sell.
 */
export function priceAnomaly(
  rarity: string | null | undefined,
  priceMicroUsdc: bigint,
): 'underpriced' | 'overpriced' | null {
  const r = normaliseRarity(rarity);
  if (r === null) return null;
  const median = MEDIAN_MICRO_USDC[r];
  const max = MAX_OBSERVED_MICRO_USDC[r];
  if (priceMicroUsdc * 4n <= median) return 'underpriced';
  if (priceMicroUsdc > max * 2n) return 'overpriced';
  return null;
}
