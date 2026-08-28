/**
 * ============================================================================
 *  TREASURY — the ONLY module permitted to sign Solana transactions
 * ============================================================================
 *
 * `src/wallet/signer.ts` still cannot sign transactions, and the game path
 * still never touches this module. The bot's gameplay and selling loops remain
 * signature-free.
 *
 * What changed, and what the guarantee now is
 * -------------------------------------------
 * Consolidating proceeds needs on-chain transfers. So this module can sign —
 * but it is fenced by one invariant that is enforced on every transfer and
 * covered by tests:
 *
 *      FUNDS MAY ONLY MOVE WITHIN YOUR OWN FLEET.
 *
 *   sweep : any fleet wallet  ->  the configured MAIN account        (any asset)
 *   fund  : the MAIN account  ->  any fleet wallet   (SOL only, amount-capped)
 *
 * Any destination outside the loaded fleet is refused before a transaction is
 * even built. A compromised process therefore cannot exfiltrate funds to an
 * attacker's address; the worst it can do is shuffle your money between your
 * own wallets.
 *
 * This is a weaker guarantee than "cannot sign at all", and that trade is
 * deliberate and operator-chosen. It is not a weaker guarantee than any
 * ordinary hot wallet.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getMint,
} from '@solana/spl-token';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import { logger } from '../log.js';

const log = logger('treasury');

/** Lamports kept in every wallet so it can still pay its own rent/fees. */
export const SOL_DUST_RESERVE = 2_000_000n; // 0.002 SOL

export class TransferRefusedError extends Error {
  constructor(reason: string) {
    super(`transfer refused: ${reason}`);
    this.name = 'TransferRefusedError';
  }
}

export interface FleetMember {
  id: string;
  address: string;
  keypairPath: string;
}

export interface TokenHolding {
  mint: string;
  programId: string;
  amount: bigint;
  decimals: number;
  ata: string;
}

/**
 * Load a signing keypair. Deliberately separate from `loadAccount()` in
 * keystore.ts: the gameplay path gets a LoginSigner that cannot sign
 * transactions, and only treasury commands ever construct a full Keypair.
 */
export function loadKeypair(path: string): Keypair {
  const text = readFileSync(path, 'utf8').trim();
  if (text.startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text) as number[]));
  }
  return Keypair.fromSecretKey(bs58.decode(text));
}

export interface TreasuryOptions {
  connection: Connection;
  /** Every wallet the operator controls. Nothing outside this set is reachable. */
  fleet: readonly FleetMember[];
  /** Address of the main account that sweeps collect into. */
  mainAddress: string;
  /** Hard cap on a single gas top-up, in lamports. */
  maxFundLamports: bigint;
}

export class Treasury {
  private readonly byAddress: Map<string, FleetMember>;

  constructor(private readonly o: TreasuryOptions) {
    this.byAddress = new Map(o.fleet.map((m) => [m.address, m]));
    if (!this.byAddress.has(o.mainAddress)) {
      throw new TransferRefusedError(
        `main account ${o.mainAddress} is not one of the loaded wallets — ` +
          `refusing to operate with an unknown destination`,
      );
    }
  }

  get main(): FleetMember {
    return this.byAddress.get(this.o.mainAddress)!;
  }

  /** THE GUARD. Every transfer passes through here before anything is built. */
  private assertAllowed(from: string, to: string, asset: 'sol' | 'token', amount: bigint): void {
    if (!this.byAddress.has(from)) {
      throw new TransferRefusedError(`source ${from} is not a fleet wallet`);
    }
    if (!this.byAddress.has(to)) {
      throw new TransferRefusedError(
        `destination ${to} is not a fleet wallet — funds may only move between your own wallets`,
      );
    }
    if (from === to) {
      throw new TransferRefusedError('source and destination are the same wallet');
    }
    if (amount <= 0n) {
      throw new TransferRefusedError('amount must be positive');
    }

    const toMain = to === this.o.mainAddress;
    const fromMain = from === this.o.mainAddress;

    if (toMain) return; // sweeping into main is always allowed, any asset

    if (fromMain) {
      // Outbound from main is gas funding only: SOL, and amount-capped.
      if (asset !== 'sol') {
        throw new TransferRefusedError(
          `main may only send SOL for gas, not tokens (attempted ${asset})`,
        );
      }
      if (amount > this.o.maxFundLamports) {
        throw new TransferRefusedError(
          `funding ${amount} lamports exceeds the cap of ${this.o.maxFundLamports}`,
        );
      }
      return;
    }

    throw new TransferRefusedError(
      'transfers between two non-main wallets are not permitted; sweep to main first',
    );
  }

  async solBalance(address: string): Promise<bigint> {
    return BigInt(await this.o.connection.getBalance(new PublicKey(address), 'confirmed'));
  }

  /** Every non-zero token balance held by `address`, across both token programs. */
  async tokenHoldings(address: string): Promise<TokenHolding[]> {
    const owner = new PublicKey(address);
    const out: TokenHolding[] = [];

    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const res = await this.o.connection.getParsedTokenAccountsByOwner(owner, { programId });
      for (const { pubkey, account } of res.value) {
        const info = (account.data as unknown as {
          parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } };
        }).parsed.info;
        const amount = BigInt(info.tokenAmount.amount);
        if (amount === 0n) continue;
        out.push({
          mint: info.mint,
          programId: programId.toBase58(),
          amount,
          decimals: info.tokenAmount.decimals,
          ata: pubkey.toBase58(),
        });
      }
    }
    return out;
  }

  /**
   * Move one token balance to the main account.
   * `dryRun` builds and validates everything but never broadcasts.
   */
  async transferToken(
    from: FleetMember,
    holding: TokenHolding,
    opts: { dryRun?: boolean } = {},
  ): Promise<{ signature: string | null; amount: bigint }> {
    this.assertAllowed(from.address, this.o.mainAddress, 'token', holding.amount);

    const programId = new PublicKey(holding.programId);
    const mint = new PublicKey(holding.mint);
    const owner = new PublicKey(from.address);
    const dest = new PublicKey(this.o.mainAddress);

    const srcAta = new PublicKey(holding.ata);
    const dstAta = getAssociatedTokenAddressSync(mint, dest, false, programId);

    const tx = new Transaction();

    // The destination ATA may not exist yet; the source wallet pays to create it.
    let needsAta = false;
    try {
      await getAccount(this.o.connection, dstAta, 'confirmed', programId);
    } catch {
      needsAta = true;
    }
    if (needsAta) {
      tx.add(
        createAssociatedTokenAccountInstruction(owner, dstAta, dest, mint, programId),
      );
    }

    // transferChecked verifies mint and decimals on-chain, so a wrong-mint or
    // wrong-decimals bug fails the transaction instead of moving the wrong amount.
    const mintInfo = await getMint(this.o.connection, mint, 'confirmed', programId);
    tx.add(
      createTransferCheckedInstruction(
        srcAta,
        mint,
        dstAta,
        owner,
        holding.amount,
        mintInfo.decimals,
        [],
        programId,
      ),
    );

    if (opts.dryRun) {
      log.info(
        `[dry-run] would sweep ${holding.amount} of ${holding.mint.slice(0, 8)}… ` +
          `from ${from.id} to main`,
      );
      return { signature: null, amount: holding.amount };
    }

    const kp = loadKeypair(from.keypairPath);
    const sig = await sendAndConfirmTransaction(this.o.connection, tx, [kp], {
      commitment: 'confirmed',
    });
    log.info(`swept ${holding.amount} of ${holding.mint.slice(0, 8)}… from ${from.id}: ${sig}`);
    return { signature: sig, amount: holding.amount };
  }

  /** Move SOL, leaving a dust reserve behind so the wallet stays usable. */
  async transferSol(
    from: FleetMember,
    to: FleetMember,
    lamports: bigint,
    opts: { dryRun?: boolean } = {},
  ): Promise<{ signature: string | null; amount: bigint }> {
    this.assertAllowed(from.address, to.address, 'sol', lamports);

    if (opts.dryRun) {
      log.info(`[dry-run] would send ${lamports} lamports ${from.id} -> ${to.id}`);
      return { signature: null, amount: lamports };
    }

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(from.address),
        toPubkey: new PublicKey(to.address),
        lamports: Number(lamports),
      }),
    );
    const kp = loadKeypair(from.keypairPath);
    const sig = await sendAndConfirmTransaction(this.o.connection, tx, [kp], {
      commitment: 'confirmed',
    });
    log.info(`sent ${fmtSol(lamports)} SOL ${from.id} -> ${to.id}: ${sig}`);
    return { signature: sig, amount: lamports };
  }

  /** Sweep every token from every non-main wallet into main. */
  async sweepAll(opts: { dryRun?: boolean; includeSol?: boolean } = {}): Promise<SweepReport> {
    const report: SweepReport = { transfers: [], skipped: [], errors: [] };

    for (const member of this.o.fleet) {
      if (member.address === this.o.mainAddress) continue;

      let holdings: TokenHolding[];
      try {
        holdings = await this.tokenHoldings(member.address);
      } catch (err) {
        report.errors.push({ wallet: member.id, error: (err as Error).message });
        continue;
      }

      if (holdings.length === 0) {
        report.skipped.push({ wallet: member.id, reason: 'no token balances' });
      }

      for (const h of holdings) {
        try {
          const r = await this.transferToken(member, h, opts);
          report.transfers.push({
            wallet: member.id,
            mint: h.mint,
            amount: h.amount,
            decimals: h.decimals,
            signature: r.signature,
          });
        } catch (err) {
          report.errors.push({
            wallet: member.id,
            error: `${h.mint.slice(0, 8)}…: ${(err as Error).message}`,
          });
        }
      }

      if (opts.includeSol) {
        try {
          const bal = await this.solBalance(member.address);
          const movable = bal - SOL_DUST_RESERVE;
          if (movable > 0n) {
            const r = await this.transferSol(member, this.main, movable, opts);
            report.transfers.push({
              wallet: member.id,
              mint: 'SOL',
              amount: r.amount,
              decimals: 9,
              signature: r.signature,
            });
          } else {
            report.skipped.push({ wallet: member.id, reason: 'SOL at or below dust reserve' });
          }
        } catch (err) {
          report.errors.push({ wallet: member.id, error: `SOL: ${(err as Error).message}` });
        }
      }
    }
    return report;
  }

  /** Top up any wallet that has fallen below `minLamports`. */
  async fundGas(
    minLamports: bigint,
    topUpLamports: bigint,
    opts: { dryRun?: boolean } = {},
  ): Promise<SweepReport> {
    const report: SweepReport = { transfers: [], skipped: [], errors: [] };
    const mainBal = await this.solBalance(this.o.mainAddress);
    let remaining = mainBal - SOL_DUST_RESERVE;

    for (const member of this.o.fleet) {
      if (member.address === this.o.mainAddress) continue;
      try {
        const bal = await this.solBalance(member.address);
        if (bal >= minLamports) {
          report.skipped.push({
            wallet: member.id,
            reason: `has ${fmtSol(bal)} SOL, above the ${fmtSol(minLamports)} floor`,
          });
          continue;
        }
        if (remaining < topUpLamports) {
          report.skipped.push({ wallet: member.id, reason: 'main account has insufficient SOL' });
          continue;
        }
        const r = await this.transferSol(this.main, member, topUpLamports, opts);
        if (!opts.dryRun) remaining -= topUpLamports;
        report.transfers.push({
          wallet: member.id,
          mint: 'SOL',
          amount: r.amount,
          decimals: 9,
          signature: r.signature,
        });
      } catch (err) {
        report.errors.push({ wallet: member.id, error: (err as Error).message });
      }
    }
    return report;
  }
}

export interface SweepReport {
  transfers: {
    wallet: string;
    mint: string;
    amount: bigint;
    decimals: number;
    signature: string | null;
  }[];
  skipped: { wallet: string; reason: string }[];
  errors: { wallet: string; error: string }[];
}

export function fmtSol(lamports: bigint): string {
  const whole = lamports / BigInt(LAMPORTS_PER_SOL);
  const frac = (lamports % BigInt(LAMPORTS_PER_SOL)).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function fmtAmount(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const d = 10n ** BigInt(decimals);
  const whole = amount / d;
  const frac = (amount % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}
