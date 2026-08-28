/**
 * Token gate.
 *
 * The client only ever reads a boolean:
 *     GET /api/token-gate/status  ->  { allowed: boolean }
 *
 * The threshold lives server-side. It appears in neither the production
 * bundles nor https://playrelic.gg/docs. The operator believes it is 10,000
 * RELIC; that figure is UNVERIFIED, so this module deliberately hardcodes no
 * threshold. It reports the gate's actual answer, plus the wallet's real
 * on-chain RELIC balance for context, and lets the operator draw conclusions
 * from observed data.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { RestClient } from '../net/rest.js';
import { EP, RELIC_MINT, RELIC_DECIMALS } from '../protocol/endpoints.js';
import { logger } from '../log.js';

const log = logger('gate');

export interface GateStatus {
  allowed: boolean;
  /** On-chain RELIC balance in base units (6 decimals), null if unreadable. */
  relicBaseUnits: bigint | null;
  checkedAt: number;
}

export function formatRelic(baseUnits: bigint): string {
  const d = 10n ** BigInt(RELIC_DECIMALS);
  const whole = baseUnits / d;
  const frac = (baseUnits % d).toString().padStart(RELIC_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Read the wallet's RELIC balance directly from chain.
 *
 * $RELIC is SPL Token-2022, so the ATA must be derived with the Token-2022
 * program id — deriving with the classic SPL Token program yields a different
 * address and would always report zero.
 */
export async function readRelicBalance(
  connection: Connection,
  owner: string,
): Promise<bigint | null> {
  try {
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(RELIC_MINT),
      new PublicKey(owner),
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    const acct = await getAccount(connection, ata, 'confirmed', TOKEN_2022_PROGRAM_ID);
    return acct.amount;
  } catch (err) {
    // No ATA yet simply means a zero balance; anything else is a read failure.
    // NOTE: TokenAccountNotFoundError carries an EMPTY message, so the name
    // must be checked as well — matching on the message alone silently turned
    // every zero balance into "unknown" (caught by live test 2026-08-28).
    const e = err as Error;
    const name = e?.name ?? '';
    const msg = e?.message ?? '';
    if (
      /TokenAccountNotFound|TokenInvalidAccountOwner/i.test(name) ||
      /could not find account|TokenAccountNotFound/i.test(msg)
    ) {
      return 0n;
    }
    log.debug(`RELIC balance read failed for ${owner.slice(0, 8)}…: ${name} ${msg}`);
    return null;
  }
}

export class GateChecker {
  private cache = new Map<string, GateStatus>();

  constructor(
    private readonly rest: RestClient,
    private readonly connection: Connection | null,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  async check(accountId: string, token: string, address: string): Promise<GateStatus> {
    const hit = this.cache.get(accountId);
    if (hit && Date.now() - hit.checkedAt < this.ttlMs) return hit;

    let allowed = true;
    try {
      const res = await this.rest.get<{ allowed?: boolean }>(EP.TOKEN_GATE_STATUS, token);
      // The client treats a non-false value as allowed; mirror that exactly.
      allowed = res?.allowed !== false;
    } catch (err) {
      // The client also fails open on a network error. Mirror it, but say so,
      // because silently assuming "allowed" would hide a real gate.
      log.warn(`token-gate status unreadable for ${accountId}, assuming allowed: ${(err as Error).message}`);
    }

    const relicBaseUnits = this.connection
      ? await readRelicBalance(this.connection, address)
      : null;

    const status: GateStatus = { allowed, relicBaseUnits, checkedAt: Date.now() };
    this.cache.set(accountId, status);

    log.info(
      `${accountId} gate=${allowed ? 'OPEN' : 'CLOSED'} relic=${
        relicBaseUnits === null ? 'unknown' : formatRelic(relicBaseUnits)
      }`,
    );
    return status;
  }

  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }
}
