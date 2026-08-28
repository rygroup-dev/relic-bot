/**
 * HTTP client for the Relic REST API.
 *
 * Defence in depth: `request` refuses to call any endpoint matching
 * SPEND_ENDPOINT_PATTERNS. The primary guarantee is that no transaction-signing
 * code exists (src/wallet/signer.ts); this is the second lock on the same door,
 * so that a future careless caller cannot even begin a purchase flow.
 */

import { isSpendEndpoint } from '../protocol/endpoints.js';
import { classifyRefusal, type RefusalVerdict } from '../protocol/messages.js';
import { logger } from '../log.js';

const log = logger('rest');

export class SpendBlockedError extends Error {
  constructor(path: string) {
    super(
      `blocked spend endpoint ${path}: relic-bot cannot sign transactions by design ` +
        `(see src/wallet/signer.ts)`,
    );
    this.name = 'SpendBlockedError';
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly verdict: RefusalVerdict,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  token?: string | null;
  timeoutMs?: number;
  /** Set only by the auth module for the two unauthenticated endpoints. */
  allowUnauthenticated?: boolean;
}

/**
 * Request headers matching a real browser session.
 *
 * Taken from an actual capture of the game client rather than invented, so the
 * platform hints, UA and fetch metadata agree with each other — a Linux UA
 * paired with Windows client hints is more conspicuous than either alone.
 *
 * This only makes the HTTP surface consistent. It does not make automation
 * undetectable: timing regularity, uptime and repeated pathing are what
 * actually distinguish a bot, which is why the fleet jitters its tempo.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const CLIENT_HINTS: Readonly<Record<string, string>> = {
  'sec-ch-ua': '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'accept-language': 'en-US,en;q=0.9',
};

export class RestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly userAgent = process.env.RELIC_USER_AGENT || BROWSER_UA,
  ) {}

  async request<T = unknown>(path: string, opts: RestOptions = {}): Promise<T> {
    if (isSpendEndpoint(path)) {
      // Not a warning we recover from: this is a programming error.
      throw new SpendBlockedError(path);
    }

    const { method = 'GET', body, token, timeoutMs = 15_000 } = opts;
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.userAgent,
      origin: this.baseUrl,
      referer: `${this.baseUrl}/`,
      ...CLIENT_HINTS,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });

      const text = await res.text();
      let parsed: unknown = text;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          /* keep raw text */
        }
      }

      if (!res.ok) {
        const reason =
          (parsed as { error?: string; reason?: string } | null)?.error ??
          (parsed as { reason?: string } | null)?.reason ??
          `http_${res.status}`;
        log.debug(`${method} ${path} -> ${res.status} ${reason}`);
        throw new ApiError(
          `${method} ${path} failed: ${reason}`,
          res.status,
          parsed,
          classifyRefusal(reason),
        );
      }
      return parsed as T;
    } catch (err) {
      if (err instanceof ApiError || err instanceof SpendBlockedError) throw err;
      if ((err as Error)?.name === 'AbortError') {
        throw new ApiError(`${method} ${path} timed out`, 0, null, {
          kind: 'unknown',
          scope: 'retry',
          cooldownMs: 10_000,
          needsOperator: false,
        });
      }
      throw new ApiError(`${method} ${path}: ${(err as Error).message}`, 0, null, {
        kind: 'unknown',
        scope: 'retry',
        cooldownMs: 10_000,
        needsOperator: false,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  get<T>(path: string, token?: string | null): Promise<T> {
    return this.request<T>(path, { token });
  }

  post<T>(path: string, body: unknown, token?: string | null): Promise<T> {
    return this.request<T>(path, { method: 'POST', body, token });
  }
}
