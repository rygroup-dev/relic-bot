import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Keypair, Transaction, SystemProgram, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import {
  buildLoginMessage,
  createLoginSigner,
  assertLoginMessage,
  RefusedToSignError,
  SIGNING_CAPABILITIES,
  LOGIN_HEADER,
} from '../src/wallet/signer.js';

const kp = Keypair.generate();
const signer = createLoginSigner(kp);

describe('login message format (must match the production client byte for byte)', () => {
  it('builds the exact four-line message joined by \\n', () => {
    const msg = buildLoginMessage('ADDR', 1234567890);
    expect(msg).toBe(
      'Relic — sign in\nWallet: ADDR\nTimestamp: 1234567890\n' +
        'Only sign this on the official Relic site.',
    );
  });

  it('uses an em dash U+2014, not a hyphen', () => {
    expect(LOGIN_HEADER.codePointAt(6)).toBe(0x2014);
  });
});

describe('signature encoding', () => {
  it('returns base64, matching the client btoa() encoding', () => {
    const msg = buildLoginMessage(signer.address, 1);
    const sig = signer.signLoginMessage(msg);
    // base64 of 64 bytes is 88 chars ending in '='
    expect(sig).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(sig, 'base64')).toHaveLength(64);
  });

  it('produces a signature that verifies against the wallet public key', () => {
    const msg = buildLoginMessage(signer.address, 42);
    const sig = Buffer.from(signer.signLoginMessage(msg), 'base64');
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(msg),
      new Uint8Array(sig),
      kp.publicKey.toBytes(),
    );
    expect(ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The security property this whole bot is built around.
// ---------------------------------------------------------------------------
describe('PAYMENT HARD-LOCK: the signer cannot sign a transaction', () => {
  it('exposes exactly one capability', () => {
    expect([...SIGNING_CAPABILITIES]).toEqual(['login-message']);
  });

  it('exposes no transaction-signing method', () => {
    const surface = Object.keys(signer);
    expect(surface.sort()).toEqual(['address', 'signLoginMessage']);
    for (const forbidden of ['signTransaction', 'signAllTransactions', 'secretKey', 'sign']) {
      expect(signer).not.toHaveProperty(forbidden);
    }
  });

  it('does not leak the secret key through the object surface', () => {
    expect(JSON.stringify(signer)).not.toContain(
      Buffer.from(kp.secretKey).toString('base64'),
    );
    for (const v of Object.values(signer)) {
      expect(v).not.toBeInstanceOf(Uint8Array);
    }
  });

  it('refuses a serialised Solana transfer transaction', () => {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: kp.publicKey,
        toPubkey: new PublicKey('11111111111111111111111111111112'),
        lamports: 1_000_000,
      }),
    );
    tx.recentBlockhash = '11111111111111111111111111111111';
    tx.feePayer = kp.publicKey;
    const wire = tx.serializeMessage().toString('latin1');
    expect(() => signer.signLoginMessage(wire)).toThrow(RefusedToSignError);
  });

  it.each([
    ['empty string', ''],
    ['wrong header', 'Relic - sign in\nWallet: a\nTimestamp: 1\nOnly sign this on the official Relic site.'],
    ['extra line', 'Relic — sign in\nWallet: a\nTimestamp: 1\nevil\nOnly sign this on the official Relic site.'],
    ['missing trailer', 'Relic — sign in\nWallet: a\nTimestamp: 1\n'],
    ['reordered fields', 'Relic — sign in\nTimestamp: 1\nWallet: a\nOnly sign this on the official Relic site.'],
  ])('refuses %s', (_label, payload) => {
    expect(() => signer.signLoginMessage(payload)).toThrow(RefusedToSignError);
  });

  it('refuses non-string payloads', () => {
    for (const bad of [null, undefined, 123, {}, new Uint8Array([1, 2, 3])]) {
      expect(() => assertLoginMessage(bad)).toThrow(RefusedToSignError);
    }
  });
});

describe('PAYMENT HARD-LOCK: source-level invariant', () => {
  it('the signer module contains no transaction-signing code', () => {
    const src = readFileSync(new URL('../src/wallet/signer.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const banned of [
      'signTransaction',
      'sign.detached(tx',
      'Transaction',
      'sendRawTransaction',
      'partialSign',
    ]) {
      expect(code, `signer.ts must not reference ${banned}`).not.toContain(banned);
    }
  });

  it('treasury is the ONLY module in src/ that can sign a transaction', async () => {
    const { execSync } = await import('node:child_process');
    const hits = execSync(
      `grep -rlE '(sendAndConfirmTransaction|partialSign|sendRawTransaction|new Transaction)' ` +
        `${new URL('../src', import.meta.url).pathname} || true`,
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((p) => p.replace(/^.*\/src\//, 'src/'))
      .sort();

    // Adding a second signing module must break this test loudly. Transaction
    // signing is allowed in exactly one reviewed place, fenced by the
    // fleet-only guard in treasury.ts.
    expect(hits).toEqual(['src/wallet/treasury.ts']);
  });

  it('the gameplay path never imports the treasury', async () => {
    const { execSync } = await import('node:child_process');
    const src = new URL('../src', import.meta.url).pathname;
    const hits = execSync(`grep -rln "wallet/treasury" ${src} || true`, { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((p) => p.replace(/^.*\/src\//, 'src/'))
      .sort();

    // Only operator surfaces (CLI, Telegram) may reach the treasury. If the
    // fleet/game loop ever imports it, gameplay gains spending power.
    for (const f of hits) {
      expect(
        f === 'src/cli.ts' || f.startsWith('src/telegram/'),
        `${f} must not import the treasury`,
      ).toBe(true);
    }
  });
});
