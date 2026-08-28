import { describe, it, expect } from 'vitest';
import {
  expectedValueMicroUsdc,
  lootPriority,
  worthListing,
  priceAnomaly,
  normaliseRarity,
  MEDIAN_MICRO_USDC,
} from '../src/economy/valuation.js';

describe('valuation matches the observed market, not intuition', () => {
  it('prices mythics roughly 10x legendaries, as sampled', () => {
    const myth = expectedValueMicroUsdc('mythic')!;
    const leg = expectedValueMicroUsdc('legendary')!;
    expect(myth).toBe(10_000_000n);
    expect(leg).toBe(1_000_000n);
    expect(myth / leg).toBe(10n);
  });

  it('rates cosmetics highly — they sold above mythics by median', () => {
    expect(expectedValueMicroUsdc('cosmetic')!).toBeGreaterThan(
      expectedValueMicroUsdc('mythic')!,
    );
  });

  it('does not treat epic as meaningfully above legendary', () => {
    expect(expectedValueMicroUsdc('epic')).toBe(expectedValueMicroUsdc('legendary'));
  });

  it('refuses to guess an unknown rarity', () => {
    expect(expectedValueMicroUsdc('transcendent')).toBeNull();
    expect(expectedValueMicroUsdc(null)).toBeNull();
    expect(expectedValueMicroUsdc(undefined)).toBeNull();
  });

  it('is case and whitespace tolerant', () => {
    expect(normaliseRarity('  MYTHIC ')).toBe('mythic');
  });
});

describe('loot priority', () => {
  it('ranks mythic above legendary above nothing', () => {
    expect(lootPriority('mythic')).toBeGreaterThan(lootPriority('legendary'));
    expect(lootPriority('legendary')).toBeGreaterThan(0);
  });

  it('gives an unknown item a middling score so it is still collected', () => {
    const p = lootPriority('mystery');
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(lootPriority('mythic'));
  });

  it('always stays inside 0..1', () => {
    for (const r of [...Object.keys(MEDIAN_MICRO_USDC), 'nonsense', null]) {
      const p = lootPriority(r as string);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

describe('listing decisions', () => {
  it('lists a mythic comfortably above a $0.05 floor', () => {
    expect(worthListing('mythic', 50_000n)).toBe(true);
  });

  it('still lists a legendary at the $1 floor after the 10% fee', () => {
    // 1.00 * 0.90 = 0.90 net, well over 0.05
    expect(worthListing('legendary', 50_000n)).toBe(true);
  });

  it('declines a legendary when the operator wants at least $2 net', () => {
    expect(worthListing('legendary', 2_000_000n)).toBe(false);
  });

  it('never lists an unrecognised item', () => {
    expect(worthListing('unknown-tier', 0n)).toBe(false);
  });
});

describe('price anomalies cut both ways', () => {
  it('spots a mythic listed at the legendary floor as a bargain', () => {
    expect(priceAnomaly('mythic', 1_000_000n)).toBe('underpriced');
  });

  it('spots an ask far above anything ever observed', () => {
    expect(priceAnomaly('legendary', 100_000_000n)).toBe('overpriced');
  });

  it('stays silent on a normal price', () => {
    expect(priceAnomaly('mythic', 10_000_000n)).toBeNull();
    expect(priceAnomaly('legendary', 1_000_000n)).toBeNull();
  });

  it('says nothing about an unknown rarity', () => {
    expect(priceAnomaly('mystery', 1n)).toBeNull();
  });
});
