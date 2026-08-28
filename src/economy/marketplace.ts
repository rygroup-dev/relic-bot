/**
 * Marketplace — the bot's only revenue channel.
 *
 * Listing and cancelling are REST + Bearer and require NO signature, which is
 * why selling works under the payment hard-lock while buying does not.
 * Buying would need `payment-intents` + a signed Solana transaction; those
 * endpoints are blocked by RestClient and no signing code exists.
 */

import { RestClient } from '../net/rest.js';
import { EP, type Currency } from '../protocol/endpoints.js';
import { suggestPrice, type Comparable, type PriceSuggestion } from './pricing.js';
import { logger } from '../log.js';

const log = logger('market');

export interface Listing {
  id: string;
  itemId?: string;
  instanceId?: string;
  name?: string;
  category?: string;
  slot?: string;
  rarity?: string;
  quantity?: number;
  priceMicroUsdc?: number | string;
  currency?: Currency;
  seller?: string;
}

export interface ListingQuery {
  category?: string;
  slot?: string;
  currency?: Currency;
  rarity?: string;
  search?: string;
  sort?: string;
  offset?: number;
  limit?: number;
}

export interface SellableItem {
  /** Unique instance (gear) or stackable item id. */
  kind: 'instance' | 'stack';
  instanceId?: string;
  itemId?: string;
  quantity?: number;
  name: string;
  category?: string;
  slot?: string;
  rarity?: string;
}

function toBigIntMicro(v: number | string | undefined): bigint | null {
  if (v === undefined || v === null) return null;
  try {
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || v < 0) return null;
      return BigInt(Math.round(v));
    }
    const t = v.trim();
    if (!/^\d+$/.test(t)) return null;
    return BigInt(t);
  } catch {
    return null;
  }
}

export class Marketplace {
  constructor(private readonly rest: RestClient) {}

  async listings(token: string, q: ListingQuery = {}): Promise<Listing[]> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    const res = await this.rest.get<{ listings?: Listing[] }>(
      `${EP.MARKETPLACE_LISTINGS}${qs ? `?${qs}` : ''}`,
      token,
    );
    return res?.listings ?? [];
  }

  async myListings(token: string): Promise<Listing[]> {
    const res = await this.rest.get<{ listings?: Listing[] }>(EP.MARKETPLACE_MY_LISTINGS, token);
    return res?.listings ?? [];
  }

  async logs(token: string): Promise<unknown[]> {
    const res = await this.rest.get<{ logs?: unknown[] }>(EP.MARKETPLACE_LOGS, token);
    return res?.logs ?? [];
  }

  /** Comparable listings for an item, used to price a sale. */
  async comparablesFor(token: string, item: SellableItem): Promise<Comparable[]> {
    const listings = await this.listings(token, {
      search: item.name,
      ...(item.category ? { category: item.category } : {}),
      ...(item.slot ? { slot: item.slot } : {}),
      ...(item.rarity ? { rarity: item.rarity } : {}),
      limit: 50,
    });

    const out: Comparable[] = [];
    for (const l of listings) {
      const price = toBigIntMicro(l.priceMicroUsdc);
      if (price === null || price <= 0n) continue;
      out.push({ priceMicroUsdc: price, currency: l.currency ?? 'usdc' });
    }
    return out;
  }

  async priceFor(
    token: string,
    item: SellableItem,
    opts: {
      minNetMicroUsdc: bigint;
      relicVolatilityDiscountPct: number;
      preference: 'auto' | Currency;
    },
  ): Promise<PriceSuggestion | null> {
    const comps = await this.comparablesFor(token, item);
    return suggestPrice(comps, opts);
  }

  /** Create a listing. REST + Bearer only — no signature involved. */
  async createListing(
    token: string,
    item: SellableItem,
    price: PriceSuggestion,
  ): Promise<{ ok: boolean; id?: string; reason?: string }> {
    const body =
      item.kind === 'instance'
        ? {
            kind: 'instance',
            instanceId: item.instanceId,
            priceMicroUsdc: price.priceMicroUsdc.toString(),
            currency: price.currency,
          }
        : {
            kind: 'stack',
            itemId: item.itemId,
            quantity: item.quantity ?? 1,
            priceMicroUsdc: price.priceMicroUsdc.toString(),
            currency: price.currency,
          };

    const res = await this.rest.post<{ ok?: boolean; id?: string; listingId?: string; error?: string }>(
      EP.MARKETPLACE_LISTINGS,
      body,
      token,
    );

    const ok = res?.ok !== false && !res?.error;
    const id = res?.id ?? res?.listingId;
    log.info(
      `list ${item.name} @ ${price.priceMicroUsdc} micro ${price.currency} -> ${
        ok ? `ok ${id ?? ''}` : `failed ${res?.error}`
      }`,
    );
    return ok ? { ok: true, ...(id ? { id } : {}) } : { ok: false, reason: res?.error ?? 'unknown' };
  }

  async cancel(token: string, listingId: string): Promise<boolean> {
    const res = await this.rest.post<{ ok?: boolean }>(
      EP.marketplaceCancel(listingId),
      {},
      token,
    );
    return res?.ok !== false;
  }
}
