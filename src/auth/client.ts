/**
 * Wallet authentication, reproduced from the production client.
 *
 *   GET  /api/auth/now     -> { now }
 *   sign "Relic — sign in\nWallet: <addr>\nTimestamp: <now>\n<trailer>"
 *   POST /api/auth/verify  -> { token, walletAddress, character, characters, ban? }
 *
 * The only cryptographic operation is an ed25519 signature over that UTF-8
 * text. It cannot authorise a transfer.
 */

import { RestClient, ApiError } from '../net/rest.js';
import { EP } from '../protocol/endpoints.js';
import { buildLoginMessage } from '../wallet/signer.js';
import type { Account } from '../wallet/keystore.js';
import { authLimiter, isRateLimited } from '../net/ratelimit.js';
import { logger } from '../log.js';

const log = logger('auth');

export interface BanInfo {
  reason: string;
  permanent?: boolean;
  expiresAt?: string;
}

export interface Character {
  id: string;
  name?: string;
  classId?: string;
  level?: number;
}

export interface Session {
  token: string;
  walletAddress: string;
  character: Character | null;
  characters: Character[];
  unlocks: string[];
  ban: BanInfo | null;
}

export class BannedError extends Error {
  constructor(readonly ban: BanInfo, readonly walletAddress: string) {
    super(
      `wallet ${walletAddress} is banned: ${ban.reason}` +
        (ban.permanent ? ' (permanent)' : ban.expiresAt ? ` until ${ban.expiresAt}` : ''),
    );
    this.name = 'BannedError';
  }
}

export class AuthClient {
  constructor(private readonly rest: RestClient) {}

  /** Server clock, used so the signed timestamp cannot drift out of tolerance. */
  private async serverNow(): Promise<number> {
    try {
      const res = await this.rest.get<{ now?: number }>(EP.AUTH_NOW);
      if (typeof res?.now === 'number' && Number.isFinite(res.now)) return res.now;
    } catch (err) {
      log.warn(`auth/now unavailable, falling back to local clock: ${(err as Error).message}`);
    }
    return Date.now();
  }

  async login(account: Account): Promise<Session> {
    const timestamp = await this.serverNow();
    const message = buildLoginMessage(account.address, timestamp);
    const signature = account.signer.signLoginMessage(message);

    let res: {
      /** The live server returns `sessionToken`; `token` is accepted as a
       *  fallback in case the field is ever renamed back. Verified against
       *  production 2026-08-28. */
      sessionToken?: string;
      token?: string;
      walletAddress?: string;
      character?: Character | null;
      characters?: Character[];
      unlocks?: string[];
      error?: string;
      ban?: BanInfo;
    };

    try {
      // Every login in the process shares one gate: the rate limit belongs to
      // the server, so spacing wallet starts alone never fixed the bursts that
      // reconnects and restarts produce.
      res = await authLimiter.run(
        () =>
          this.rest.post(EP.AUTH_VERIFY, {
            deviceId: account.deviceId,
            walletType: 'phantom',
            proof: {
              walletAddress: account.address,
              message,
              signature,
              timestamp,
            },
          }),
        isRateLimited,
      );
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { error?: string; ban?: BanInfo } | null;
        if (body?.error === 'banned' && body.ban) {
          throw new BannedError(body.ban, account.address);
        }
      }
      throw err;
    }

    if (res.error === 'banned' && res.ban) {
      throw new BannedError(res.ban, account.address);
    }
    const token = res.sessionToken ?? res.token;
    if (!token) {
      throw new Error(
        `auth/verify returned no sessionToken for ${account.id} ` +
          `(fields: ${Object.keys(res).join(', ') || 'none'})`,
      );
    }

    log.info(`${account.id} authenticated as ${account.address.slice(0, 8)}…`);
    return {
      token,
      walletAddress: res.walletAddress ?? account.address,
      character: res.character ?? null,
      characters: res.characters ?? [],
      unlocks: res.unlocks ?? [],
      ban: res.ban ?? null,
    };
  }

  async characters(token: string): Promise<Character[]> {
    const res = await this.rest.get<{ characters?: Character[] }>(EP.CHARACTERS, token);
    return res?.characters ?? [];
  }

  /** Full roster plus the unlock list that decides which classes are usable. */
  async roster(token: string): Promise<{ characters: Character[]; unlocks: string[] }> {
    const res = await this.rest.get<{ characters?: Character[]; unlocks?: string[] }>(
      EP.CHARACTERS,
      token,
    );
    return { characters: res?.characters ?? [], unlocks: res?.unlocks ?? [] };
  }

  /**
   * Create a character. The name is PERMANENT — the game says so in its own UI —
   * so this is only ever called on an explicit operator instruction.
   *
   * Server errors seen in the client: `exists` / `classExists` when the wallet
   * already owns that class.
   */
  async createCharacter(token: string, classId: string, name: string): Promise<Character | null> {
    const res = await this.rest.post<{ character?: Character; error?: string }>(
      EP.CHARACTER,
      { classId, name },
      token,
    );
    if (res?.error) throw new Error(res.error);
    return res?.character ?? null;
  }

  /**
   * Select a character. A gated class rejects with `token_required`, which is
   * the RELIC-holding requirement surfacing — not a bug.
   */
  async selectCharacter(token: string, userId: string): Promise<void> {
    await this.rest.post(EP.CHARACTER_SELECT, { userId }, token);
  }
}
