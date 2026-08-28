/**
 * Multi-account key loading.
 *
 * Keys live OUTSIDE the repository tree, in a directory that must be mode 0700
 * with 0600 files. The loader refuses to read world- or group-readable key
 * material rather than silently accepting an insecure deployment.
 *
 * Accepted formats per account file:
 *   - base58 secret key (64 bytes decoded) -- what Phantom "export private key" gives
 *   - JSON array of 64 integers             -- solana-keygen / CLI format
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, extname } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createLoginSigner, type LoginSigner } from './signer.js';

export interface Account {
  /** Stable label derived from the filename, e.g. "wallet-01". */
  readonly id: string;
  readonly address: string;
  readonly signer: LoginSigner;
  /**
   * Persistent per-account device id. The game enforces one live session per
   * account (`device_busy`), so each account needs its own stable id. Derived
   * deterministically from the address so it survives restarts without being
   * stored anywhere.
   */
  readonly deviceId: string;
}

export class KeystoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeystoreError';
  }
}

function parseSecret(raw: string, source: string): Keypair {
  const text = raw.trim();
  if (!text) throw new KeystoreError(`${source}: file is empty`);

  if (text.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new KeystoreError(`${source}: not valid JSON`);
    }
    if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((n) => Number.isInteger(n))) {
      throw new KeystoreError(`${source}: JSON key must be 64 integers, got ${
        Array.isArray(arr) ? arr.length : typeof arr
      }`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(arr as number[]));
  }

  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(text);
  } catch {
    throw new KeystoreError(`${source}: not base58 and not a JSON array`);
  }
  if (decoded.length !== 64) {
    throw new KeystoreError(
      `${source}: base58 key decoded to ${decoded.length} bytes, expected 64`,
    );
  }
  return Keypair.fromSecretKey(decoded);
}

/** Refuse key files that other users on the box can read. */
function assertPrivateMode(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    throw new KeystoreError(
      `${path}: permissions ${mode.toString(8)} are too open — run: chmod 600 ${path}`,
    );
  }
}

/**
 * Device id derived from the wallet address. Deterministic (survives restart),
 * distinct per account (avoids one fingerprint across the fleet), and reveals
 * nothing about the secret key.
 */
export function deriveDeviceId(address: string): string {
  return createHash('sha256')
    .update(`relic-bot:device:${address}`)
    .digest('hex')
    .slice(0, 32)
    .toUpperCase();
}

export function loadAccount(path: string): Account {
  assertPrivateMode(path);
  const kp = parseSecret(readFileSync(path, 'utf8'), basename(path));
  const signer = createLoginSigner(kp);
  return Object.freeze({
    id: basename(path, extname(path)),
    address: signer.address,
    signer,
    deviceId: deriveDeviceId(signer.address),
  });
}

/**
 * Load every account in `dir`, sorted by filename so fleet ordering is stable
 * across restarts (matters for staggered start offsets).
 */
export function loadFleet(dir: string): Account[] {
  if (!existsSync(dir)) {
    throw new KeystoreError(`keys directory not found: ${dir}`);
  }
  const dirMode = statSync(dir).mode & 0o777;
  if (dirMode & 0o077) {
    throw new KeystoreError(
      `${dir}: permissions ${dirMode.toString(8)} are too open — run: chmod 700 ${dir}`,
    );
  }

  const files = readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .filter((f) => ['.key', '.json', '.txt', ''].includes(extname(f)))
    .sort();

  if (files.length === 0) {
    throw new KeystoreError(`no key files found in ${dir}`);
  }

  const accounts = files.map((f) => loadAccount(join(dir, f)));

  const seen = new Map<string, string>();
  for (const a of accounts) {
    const prev = seen.get(a.address);
    if (prev) {
      throw new KeystoreError(
        `duplicate wallet ${a.address}: both "${prev}" and "${a.id}" — ` +
          `the game enforces one session per account, so duplicates would fight`,
      );
    }
    seen.set(a.address, a.id);
  }
  return accounts;
}
