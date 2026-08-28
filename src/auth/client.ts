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
      token?: string;
      walletAddress?: string;
      character?: Character | null;
      characters?: Character[];
      error?: string;
      ban?: BanInfo;
    };

    try {
      res = await this.rest.post(EP.AUTH_VERIFY, {
        deviceId: account.deviceId,
        walletType: 'phantom',
        proof: {
          walletAddress: account.address,
          message,
          signature,
          timestamp,
        },
      });
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
    if (!res.token) {
      throw new Error(`auth/verify returned no token for ${account.id}`);
    }

    log.info(`${account.id} authenticated as ${account.address.slice(0, 8)}…`);
    return {
      token: res.token,
      walletAddress: res.walletAddress ?? account.address,
      character: res.character ?? null,
      characters: res.characters ?? [],
      ban: res.ban ?? null,
    };
  }

  async characters(token: string): Promise<Character[]> {
    const res = await this.rest.get<{ characters?: Character[] }>(EP.CHARACTERS, token);
    return res?.characters ?? [];
  }

  async selectCharacter(token: string, characterId: string): Promise<void> {
    await this.rest.post(EP.CHARACTER_SELECT, { characterId }, token);
  }
}
