/**
 * REST surface, reverse-engineered from the production bundles.
 *
 * SPEND vs EARN is annotated deliberately. Every SPEND endpoint follows the
 * `intent -> sign -> confirm` pattern and therefore requires signing a Solana
 * transaction. This bot does not implement transaction signing at all (see
 * src/wallet/signer.ts), so SPEND endpoints are listed for completeness and
 * documentation only — they are never called.
 */

export const EP = {
  // ---------- auth (no signature beyond an ed25519 login message) ----------
  AUTH_NOW: '/api/auth/now',
  AUTH_VERIFY: '/api/auth/verify',
  AUTH_LOGOUT: '/api/auth/logout',

  // ---------- character ----------
  CHARACTERS: '/api/characters',
  CHARACTER: '/api/character',
  CHARACTER_SELECT: '/api/character/select',
  TUTORIAL_TOWN: '/api/tutorial/town',

  // ---------- gating / read-only ----------
  TOKEN_GATE_STATUS: '/api/token-gate/status',
  PAYMENTS_USDC_BALANCE: '/api/payments/usdc-balance',
  PAYMENTS_SOLANA_BLOCKHASH: '/api/payments/solana-blockhash',

  // ---------- marketplace: EARN (no signature required) ----------
  MARKETPLACE_LISTINGS: '/api/marketplace/listings',
  MARKETPLACE_MY_LISTINGS: '/api/marketplace/my-listings',
  MARKETPLACE_LOGS: '/api/marketplace/logs',
  marketplaceCancel: (id: string) =>
    `/api/marketplace/listings/${encodeURIComponent(id)}/cancel`,

  // ---------- marketplace: SPEND (never called — no tx signing) ----------
  marketplacePaymentIntent: (id: string) =>
    `/api/marketplace/listings/${encodeURIComponent(id)}/payment-intent`,
  marketplaceIntentStatus: (id: string) =>
    `/api/marketplace/payment-intents/${encodeURIComponent(id)}`,
  marketplaceIntentSign: (id: string) =>
    `/api/marketplace/payment-intents/${encodeURIComponent(id)}/sign`,

  // ---------- reliquaries: read + gold-earning defence ----------
  RELIQUARIES: '/api/reliquaries',
  RELIQUARIES_VISITS: '/api/reliquaries/visits',
  reliquary: (id: string) => `/api/reliquaries/${encodeURIComponent(id)}`,
  reliquaryEnter: (id: string) => `/api/reliquaries/${encodeURIComponent(id)}/enter`,
  reliquaryThumbnail: (id: string) =>
    `/api/reliquaries/${encodeURIComponent(id)}/thumbnail`,
  reliquaryClaimTicket: (id: string) =>
    `/api/reliquaries/${encodeURIComponent(id)}/claim-ticket`,
  // SPEND
  reliquaryBuyIntent: (id: string) =>
    `/api/reliquaries/${encodeURIComponent(id)}/buy/intent`,
  reliquaryBuyConfirm: (id: string) =>
    `/api/reliquaries/${encodeURIComponent(id)}/buy/confirm`,

  // ---------- SPEND: rare shop / battlepass / rebirth offers ----------
  SHOP_RARE: '/api/shop/rare',
  BATTLEPASS: '/api/battlepass',
  BATTLEPASS_CLAIM: '/api/battlepass/claim',
  REBIRTH_ARTIFACT_OFFER: '/api/rebirth/artifact-offer',
  REBIRTH_ARTIFACT_OFFER_SELECT: '/api/rebirth/artifact-offer/select',
} as const;

/**
 * Endpoints that require signing a Solana transaction to complete.
 * The HTTP client refuses to call anything in this set — a defence in depth
 * behind the fact that no signing code exists.
 */
export const SPEND_ENDPOINT_PATTERNS: readonly RegExp[] = [
  /\/buy\/intent$/,
  /\/buy\/confirm$/,
  /\/payment-intents?\b/,
  /\/api\/shop\/rare\b/,
  /\/api\/battlepass\b/,
  /\/api\/rebirth\/artifact-offer\b/,
  /\/intent$/,
  /\/confirm$/,
] as const;

export function isSpendEndpoint(path: string): boolean {
  return SPEND_ENDPOINT_PATTERNS.some((re) => re.test(path));
}

/**
 * Marketplace fee, seller-paid.
 *
 * ⚠️ The docs and the shipped client DISAGREE, and the client wins.
 *
 * https://playrelic.gg/docs says "10% for USDC listings or 5% for RELIC
 * listings". The deployed client computes both at 1000 bps:
 *
 *   const y8 = 1000n, S8 = 1000n;
 *   xy(c) = c === "relic" ? S8 : y8        // both 1000
 *   v8(c) = Number(xy(c)) / 1e4            // 0.10, shown to the player as 10%
 *   E8(price, c) => fee = (price * xy(c) + 5000n) / 10000n
 *
 * So RELIC carries no fee advantage at all. Trusting the docs here would have
 * overstated RELIC proceeds by 5 percentage points on every sale.
 */
export const MARKETPLACE_FEE_BPS = {
  usdc: 1000, // 10%
  relic: 1000, // 10% — not 5%, despite the docs
} as const;

/**
 * Minimum accepted listing price, enforced client-side as the form's `min`.
 *
 *   b8(c) = BigInt(c === "relic" ? 1e10 : 1e6)
 *
 * That is $1.00 in micro-USDC, or 10,000 RELIC at 6 decimals. It explains the
 * "$1.00 median" seen across 237 legendary listings: that is not what the
 * market decided, it is the floor the game allows.
 */
export const MIN_LISTING_PRICE = {
  usdc: 1_000_000n, // $1.00
  relic: 10_000_000_000n, // 10,000 RELIC
} as const;

/**
 * RELIC that must be HELD to sell at all.
 *
 * Verified from the client's own copy, not inferred:
 *   "Selling on the marketplace (and buying $Relic-priced listings) requires
 *    holding 10,000 $Relic. Browsing and buying with USDC are free."
 *   "The game is free to play. To continue playing, you need to hold 10,000 $Relic."
 *
 * The gate endpoint returns only { allowed }, so this figure cannot be read at
 * runtime — it is recorded here as documentation and never used as a
 * threshold. The bot still trusts /api/token-gate/status alone.
 */
export const DOCUMENTED_GATE_HOLD_RELIC = 10_000;

export type Currency = keyof typeof MARKETPLACE_FEE_BPS;

/** $RELIC — verified on-chain 2026-08-28. SPL Token-2022. */
export const RELIC_MINT = '2ABbnf3EzGfiMa3PE2bseAWwRD4jAE4KgE8YjSTxpump';
export const RELIC_DECIMALS = 6;
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** USDC mainnet mint (classic SPL Token program). */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DECIMALS = 6;
