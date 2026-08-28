import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { loadFleet, loadAccount, deriveDeviceId, KeystoreError } from '../src/wallet/keystore.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relic-keys-'));
  chmodSync(dir, 0o700);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeKey(name: string, kp: Keypair, format: 'b58' | 'json' = 'b58'): string {
  const p = join(dir, name);
  const body =
    format === 'b58' ? bs58.encode(kp.secretKey) : JSON.stringify([...kp.secretKey]);
  writeFileSync(p, body, { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

describe('key formats', () => {
  it('loads a base58 secret key (Phantom export)', () => {
    const kp = Keypair.generate();
    const a = loadAccount(writeKey('wallet-01.key', kp));
    expect(a.address).toBe(kp.publicKey.toBase58());
    expect(a.id).toBe('wallet-01');
  });

  it('loads a JSON array secret key (solana-keygen)', () => {
    const kp = Keypair.generate();
    const a = loadAccount(writeKey('w.json', kp, 'json'));
    expect(a.address).toBe(kp.publicKey.toBase58());
  });

  it('rejects an empty file with a clear message', () => {
    const p = join(dir, 'empty.key');
    writeFileSync(p, '   ', { mode: 0o600 });
    expect(() => loadAccount(p)).toThrow(/is empty/);
  });

  it('rejects a JSON array of the wrong length', () => {
    const p = join(dir, 'short.json');
    writeFileSync(p, JSON.stringify([1, 2, 3]), { mode: 0o600 });
    expect(() => loadAccount(p)).toThrow(/64 integers/);
  });

  it('rejects a base58 blob that is not 64 bytes', () => {
    const p = join(dir, 'bad.key');
    writeFileSync(p, bs58.encode(Buffer.alloc(32)), { mode: 0o600 });
    expect(() => loadAccount(p)).toThrow(/expected 64/);
  });
});

describe('permissions are enforced, not suggested', () => {
  it('refuses a world-readable key file', () => {
    const p = writeKey('open.key', Keypair.generate());
    chmodSync(p, 0o644);
    expect(() => loadAccount(p)).toThrow(/too open/);
  });

  it('refuses a group/world-readable keys directory', () => {
    writeKey('a.key', Keypair.generate());
    chmodSync(dir, 0o755);
    expect(() => loadFleet(dir)).toThrow(/too open/);
  });
});

describe('multi-account fleet', () => {
  it('loads several accounts in stable filename order', () => {
    writeKey('wallet-02.key', Keypair.generate());
    writeKey('wallet-01.key', Keypair.generate());
    writeKey('wallet-03.key', Keypair.generate());
    const fleet = loadFleet(dir);
    expect(fleet.map((a) => a.id)).toEqual(['wallet-01', 'wallet-02', 'wallet-03']);
  });

  it('rejects a duplicated wallet, which would fight over one session', () => {
    const kp = Keypair.generate();
    writeKey('a.key', kp);
    writeKey('b.key', kp);
    expect(() => loadFleet(dir)).toThrow(/duplicate wallet/);
  });

  it('errors clearly when the directory is missing or empty', () => {
    expect(() => loadFleet(join(dir, 'nope'))).toThrow(KeystoreError);
    const empty = join(dir, 'empty');
    mkdirSync(empty, { mode: 0o700 });
    expect(() => loadFleet(empty)).toThrow(/no key files/);
  });
});

describe('device ids', () => {
  it('is deterministic per address so it survives a restart', () => {
    const addr = Keypair.generate().publicKey.toBase58();
    expect(deriveDeviceId(addr)).toBe(deriveDeviceId(addr));
  });

  it('differs between accounts so the fleet is not one fingerprint', () => {
    const a = deriveDeviceId(Keypair.generate().publicKey.toBase58());
    const b = deriveDeviceId(Keypair.generate().publicKey.toBase58());
    expect(a).not.toBe(b);
  });

  it('leaks nothing about the secret key', () => {
    const kp = Keypair.generate();
    const id = deriveDeviceId(kp.publicKey.toBase58());
    expect(id).toMatch(/^[0-9A-F]{32}$/);
    expect(bs58.encode(kp.secretKey)).not.toContain(id);
  });
});
