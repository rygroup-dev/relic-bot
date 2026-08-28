/**
 * Wallet lifecycle: create, import, export, and choosing the main account.
 *
 * Used by the installer, the CLI, and the Telegram control surface. Every file
 * this module writes is 0600 inside a 0700 directory, and every read validates
 * those permissions before touching the contents.
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  readdirSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { loadFleet, loadAccount, type Account } from './keystore.js';
import type { FleetMember } from './treasury.js';

export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

export function ensureKeysDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Next free `wallet-NN` id in the directory. */
export function nextWalletId(dir: string): string {
  ensureKeysDir(dir);
  const used = new Set(
    readdirSync(dir)
      .map((f) => /^wallet-(\d+)\./.exec(f)?.[1])
      .filter((n): n is string => Boolean(n))
      .map(Number),
  );
  let n = 1;
  while (used.has(n)) n += 1;
  return `wallet-${String(n).padStart(2, '0')}`;
}

export interface CreatedWallet {
  id: string;
  address: string;
  path: string;
}

/** Generate a brand-new keypair and persist it at 0600. */
export function createWallet(dir: string, id?: string): CreatedWallet {
  ensureKeysDir(dir);
  const walletId = id ?? nextWalletId(dir);
  const path = join(dir, `${walletId}.key`);
  if (existsSync(path)) {
    throw new WalletError(`${walletId} already exists — refusing to overwrite a key`);
  }
  const kp = Keypair.generate();
  writeFileSync(path, bs58.encode(kp.secretKey), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { id: walletId, address: kp.publicKey.toBase58(), path };
}

/** Hard ceiling on one bulk generation request. */
export const MAX_BULK_MINT = 10;

/**
 * Generate several wallets at once.
 *
 * Capped at MAX_BULK_MINT per call so a mis-tap cannot mint hundreds of keys,
 * each of which is real key material the operator then has to back up. Every
 * wallet is created individually, so a failure part-way still leaves the ones
 * already written intact and usable.
 */
export function createWallets(dir: string, count: number): CreatedWallet[] {
  const n = Math.floor(count);
  if (!Number.isFinite(n) || n < 1) {
    throw new WalletError('count must be at least 1');
  }
  if (n > MAX_BULK_MINT) {
    throw new WalletError(`cannot mint more than ${MAX_BULK_MINT} wallets at once (asked for ${n})`);
  }
  const made: CreatedWallet[] = [];
  for (let i = 0; i < n; i++) made.push(createWallet(dir));
  return made;
}

/**
 * Import an existing secret key. Accepts a base58 string (Phantom export) or a
 * JSON array of 64 integers (solana-keygen). Validates before writing, so a
 * malformed paste never lands on disk.
 */
export function importWallet(dir: string, secret: string, id?: string): CreatedWallet {
  ensureKeysDir(dir);
  const text = secret.trim();
  if (!text) throw new WalletError('no key material supplied');

  let kp: Keypair;
  try {
    if (text.startsWith('[')) {
      const arr = JSON.parse(text) as unknown;
      if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((n) => Number.isInteger(n))) {
        throw new Error('JSON key must be exactly 64 integers');
      }
      kp = Keypair.fromSecretKey(Uint8Array.from(arr as number[]));
    } else {
      const decoded = bs58.decode(text);
      if (decoded.length !== 64) {
        throw new Error(`base58 key decoded to ${decoded.length} bytes, expected 64`);
      }
      kp = Keypair.fromSecretKey(decoded);
    }
  } catch (err) {
    throw new WalletError(`not a valid Solana secret key: ${(err as Error).message}`);
  }

  const address = kp.publicKey.toBase58();

  // Refuse a duplicate: the game allows only one live session per account, so
  // two files for one wallet would fight each other.
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    try {
      if (loadAccount(p).address === address) {
        throw new WalletError(`wallet ${address} is already imported as "${f}"`);
      }
    } catch (e) {
      if (e instanceof WalletError) throw e;
      // Unreadable neighbour file must not block a valid import.
    }
  }

  const walletId = id ?? nextWalletId(dir);
  const path = join(dir, `${walletId}.key`);
  if (existsSync(path)) {
    throw new WalletError(`${walletId} already exists — refusing to overwrite a key`);
  }

  // Write to a temp file then rename, so an interrupted write cannot leave a
  // half-written key that would decode to the wrong wallet.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, bs58.encode(kp.secretKey), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return { id: walletId, address, path };
}

/**
 * Export one wallet as a solana-keygen style JSON array.
 *
 * This returns real key material. Callers are responsible for how it travels:
 * the Telegram surface sends it only to an allowlisted owner and deletes the
 * message afterwards.
 */
export function exportWalletJson(dir: string, walletId: string): {
  id: string;
  address: string;
  json: string;
} {
  const path = join(dir, `${walletId}.key`);
  if (!existsSync(path)) throw new WalletError(`no such wallet: ${walletId}`);

  const text = readFileSync(path, 'utf8').trim();
  const kp = text.startsWith('[')
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text) as number[]))
    : Keypair.fromSecretKey(bs58.decode(text));

  return {
    id: walletId,
    address: kp.publicKey.toBase58(),
    json: JSON.stringify(Array.from(kp.secretKey)),
  };
}

/** Fleet members in the shape the treasury needs. */
export function fleetMembers(dir: string): FleetMember[] {
  return loadFleet(dir).map((a: Account) => ({
    id: a.id,
    address: a.address,
    keypairPath: join(dir, `${a.id}.key`),
  }));
}

/**
 * Resolve the configured main account.
 *
 * Accepts a wallet id ("wallet-01") or a raw address. Falls back to the first
 * wallet so a single-wallet install works with no configuration at all.
 */
export function resolveMain(members: readonly FleetMember[], configured?: string): FleetMember {
  if (members.length === 0) throw new WalletError('no wallets configured');
  if (!configured || !configured.trim()) return members[0]!;

  const want = configured.trim();
  const found = members.find((m) => m.id === want || m.address === want);
  if (!found) {
    throw new WalletError(
      `main account "${want}" is not one of the loaded wallets ` +
        `(${members.map((m) => m.id).join(', ')})`,
    );
  }
  return found;
}

/** Write a single KEY=value into .env, replacing any existing line. */
export function persistEnvValue(envPath: string, key: string, value: string): void {
  let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    text += `${text.endsWith('\n') || text === '' ? '' : '\n'}${line}\n`;
  }
  writeFileSync(envPath, text, { mode: 0o600 });
  chmodSync(envPath, 0o600);
}

/** Persist the main-account choice into .env so it survives a restart. */
export function persistMainAccount(envPath: string, walletId: string): void {
  persistEnvValue(envPath, 'RELIC_MAIN_ACCOUNT', walletId);
}
