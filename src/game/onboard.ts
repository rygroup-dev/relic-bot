/**
 * Wallet onboarding: authenticate a fresh wallet and give it a character.
 *
 * A wallet with no character cannot enter the world at all — the server refuses
 * the join with `no_character` — so minting a wallet without onboarding it just
 * produces a key that sits parked forever.
 *
 * Two things are handled carefully here:
 *
 * 1. Class choice is driven by the server's `unlocks` array, never hardcoded.
 *    Gated classes reject with `token_required`, which is the RELIC-holding
 *    requirement surfacing; free classes are whatever the server says they are.
 *
 * 2. /api/auth/verify rate-limits aggressively. Onboarding a batch therefore
 *    paces itself and retries a rate-limited wallet rather than burning through
 *    the batch and failing most of it.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { AuthClient, type Character } from '../auth/client.js';
import type { Account } from '../wallet/keystore.js';
import { CLASSES, type ClassId } from '../protocol/messages.js';
import { generateName } from './names.js';
import { logger } from '../log.js';

const log = logger('onboard');

/**
 * Preference order when the server leaves the choice open. Ordered by how
 * forgiving each class is to play unattended: durable front-liners first,
 * squishier burst classes last.
 */
export const CLASS_PREFERENCE: readonly ClassId[] = [
  'knight',
  'hunter',
  'rogue',
  'assassin',
  'mage',
  'necromancer',
];

export interface OnboardResult {
  walletId: string;
  address: string;
  ok: boolean;
  classId?: ClassId;
  name?: string;
  reason?: string;
  alreadyHad?: boolean;
}

export interface OnboardOptions {
  /** Force a specific class instead of taking the first available one. */
  classId?: ClassId;
  /** Names already in use across the fleet, to avoid duplicates. */
  taken?: Set<string>;
  /** Attempts per wallet when the server rate-limits us. */
  maxAttempts?: number;
}

/**
 * Choose a class for a fresh wallet.
 *
 * An empty `unlocks` array is treated as "server did not restrict us" rather
 * than "nothing is available" — the client itself falls open in that case, and
 * a wrong guess here would refuse to create anything at all.
 */
export function chooseClass(unlocks: readonly string[], owned: readonly string[]): ClassId | null {
  const has = new Set(owned);
  const permitted = (c: ClassId): boolean =>
    unlocks.length === 0 ? true : unlocks.includes(c);

  for (const c of CLASS_PREFERENCE) {
    if (!has.has(c) && permitted(c)) return c;
  }
  // Preference list exhausted: fall back to any remaining permitted class.
  for (const c of CLASSES) {
    if (!has.has(c) && permitted(c)) return c;
  }
  return null;
}

function isRateLimited(err: unknown): boolean {
  return /rate_limit/i.test((err as Error)?.message ?? '');
}

/** Authenticate one wallet and create a character if it has none. */
export async function onboardAccount(
  auth: AuthClient,
  account: Account,
  opts: OnboardOptions = {},
): Promise<OnboardResult> {
  const base = { walletId: account.id, address: account.address };
  const maxAttempts = opts.maxAttempts ?? 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const session = await auth.login(account);
      const { characters, unlocks } = await auth.roster(session.token);

      if (characters.length > 0) {
        const first = characters[0] as Character;
        return {
          ...base,
          ok: true,
          alreadyHad: true,
          ...(first.classId ? { classId: first.classId as ClassId } : {}),
          ...(first.name ? { name: first.name } : {}),
        };
      }

      const owned = characters.map((c) => String(c.classId ?? ''));
      const classId = opts.classId ?? chooseClass(unlocks, owned);
      if (!classId) {
        return { ...base, ok: false, reason: 'no class available for this wallet' };
      }

      const name = generateName(classId, opts.taken ? { taken: opts.taken } : {});
      const created = await auth.createCharacter(session.token, classId, name);
      opts.taken?.add(name.toLowerCase());

      log.info(`${account.id}: created ${classId} "${name}"`);
      return { ...base, ok: true, classId, name: created?.name ?? name };
    } catch (err) {
      const msg = (err as Error).message;

      if (isRateLimited(err) && attempt < maxAttempts) {
        const backoff = 15_000 * attempt;
        log.warn(`${account.id}: rate limited, retrying in ${backoff / 1000}s`);
        await sleep(backoff);
        continue;
      }
      if (/token_required/.test(msg)) {
        return { ...base, ok: false, reason: 'class requires RELIC held on this wallet' };
      }
      return { ...base, ok: false, reason: msg };
    }
  }
  return { ...base, ok: false, reason: 'rate limited after repeated attempts' };
}

/**
 * Onboard a batch, spaced out so the auth rate limiter is not tripped.
 * `onProgress` lets a Telegram view update as it goes.
 */
export async function onboardBatch(
  auth: AuthClient,
  accounts: readonly Account[],
  opts: OnboardOptions & {
    spacingMs?: number;
    onProgress?: (done: number, total: number, last: OnboardResult) => void;
  } = {},
): Promise<OnboardResult[]> {
  const spacing = opts.spacingMs ?? 8_000;
  const taken = opts.taken ?? new Set<string>();
  const out: OnboardResult[] = [];

  for (const [i, account] of accounts.entries()) {
    if (i > 0) await sleep(spacing);
    const passthrough: OnboardOptions = { taken };
    if (opts.classId) passthrough.classId = opts.classId;
    if (opts.maxAttempts !== undefined) passthrough.maxAttempts = opts.maxAttempts;

    const r = await onboardAccount(auth, account, passthrough);
    out.push(r);
    opts.onProgress?.(out.length, accounts.length, r);
  }
  return out;
}
