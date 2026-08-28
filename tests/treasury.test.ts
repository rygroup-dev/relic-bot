import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  Treasury,
  TransferRefusedError,
  loadKeypair,
  fmtSol,
  fmtAmount,
  SOL_DUST_RESERVE,
  type FleetMember,
} from '../src/wallet/treasury.js';

let dir: string;
let fleet: FleetMember[];
let stranger: string;

function member(id: string): FleetMember {
  const kp = Keypair.generate();
  const p = join(dir, `${id}.key`);
  writeFileSync(p, bs58.encode(kp.secretKey), { mode: 0o600 });
  chmodSync(p, 0o600);
  return { id, address: kp.publicKey.toBase58(), keypairPath: p };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relic-treasury-'));
  fleet = [member('main'), member('wallet-01'), member('wallet-02')];
  stranger = Keypair.generate().publicKey.toBase58();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Reach the private guard without needing a live RPC connection. */
function guard(t: Treasury) {
  return (from: string, to: string, asset: 'sol' | 'token', amount: bigint) =>
    (
      t as unknown as {
        assertAllowed(f: string, t: string, a: 'sol' | 'token', n: bigint): void;
      }
    ).assertAllowed(from, to, asset, amount);
}

function build(mainIdx = 0, maxFund = BigInt(0.05 * LAMPORTS_PER_SOL)): Treasury {
  return new Treasury({
    connection: {} as never,
    fleet,
    mainAddress: fleet[mainIdx]!.address,
    maxFundLamports: maxFund,
  });
}

describe('main account selection', () => {
  it('accepts any fleet wallet as main', () => {
    for (let i = 0; i < fleet.length; i++) {
      expect(build(i).main.id).toBe(fleet[i]!.id);
    }
  });

  it('refuses a main account that is not one of the loaded wallets', () => {
    expect(
      () =>
        new Treasury({
          connection: {} as never,
          fleet,
          mainAddress: stranger,
          maxFundLamports: 1n,
        }),
    ).toThrow(TransferRefusedError);
  });
});

// ---------------------------------------------------------------------------
// The invariant that replaces "cannot sign at all".
// ---------------------------------------------------------------------------
describe('INVARIANT: funds may only move within your own fleet', () => {
  it('allows sweeping any asset into main', () => {
    const g = guard(build());
    expect(() => g(fleet[1]!.address, fleet[0]!.address, 'token', 1000n)).not.toThrow();
    expect(() => g(fleet[2]!.address, fleet[0]!.address, 'sol', 1000n)).not.toThrow();
  });

  it('REFUSES any destination outside the fleet', () => {
    const g = guard(build());
    for (const asset of ['sol', 'token'] as const) {
      expect(() => g(fleet[1]!.address, stranger, asset, 1n)).toThrow(TransferRefusedError);
      expect(() => g(fleet[0]!.address, stranger, asset, 1n)).toThrow(/not a fleet wallet/);
    }
  });

  it('refuses a source outside the fleet', () => {
    const g = guard(build());
    expect(() => g(stranger, fleet[0]!.address, 'sol', 1n)).toThrow(/source .* not a fleet wallet/);
  });

  it('allows main to send SOL for gas, within the cap', () => {
    const g = guard(build(0, 1_000_000n));
    expect(() => g(fleet[0]!.address, fleet[1]!.address, 'sol', 999_999n)).not.toThrow();
  });

  it('refuses gas funding above the cap', () => {
    const g = guard(build(0, 1_000_000n));
    expect(() => g(fleet[0]!.address, fleet[1]!.address, 'sol', 1_000_001n)).toThrow(
      /exceeds the cap/,
    );
  });

  it('refuses main sending TOKENS outward - gas funding is SOL only', () => {
    const g = guard(build());
    expect(() => g(fleet[0]!.address, fleet[1]!.address, 'token', 1n)).toThrow(
      /may only send SOL for gas/,
    );
  });

  it('refuses sub-to-sub transfers; everything routes through main', () => {
    const g = guard(build());
    expect(() => g(fleet[1]!.address, fleet[2]!.address, 'sol', 1n)).toThrow(
      /between two non-main wallets/,
    );
  });

  it('refuses self-transfers and non-positive amounts', () => {
    const g = guard(build());
    expect(() => g(fleet[1]!.address, fleet[1]!.address, 'sol', 1n)).toThrow(/same wallet/);
    expect(() => g(fleet[1]!.address, fleet[0]!.address, 'sol', 0n)).toThrow(/must be positive/);
    expect(() => g(fleet[1]!.address, fleet[0]!.address, 'sol', -5n)).toThrow(/must be positive/);
  });

  it('follows the main account when it is reassigned', () => {
    const g = guard(build(1)); // wallet-01 is now main
    expect(() => g(fleet[0]!.address, fleet[1]!.address, 'token', 1n)).not.toThrow();
    expect(() => g(fleet[1]!.address, fleet[0]!.address, 'token', 1n)).toThrow(
      /may only send SOL for gas/,
    );
  });
});

describe('keypair loading', () => {
  it('round-trips a base58 key', () => {
    const kp = loadKeypair(fleet[0]!.keypairPath);
    expect(kp.publicKey.toBase58()).toBe(fleet[0]!.address);
  });

  it('round-trips a JSON array key', () => {
    const kp = Keypair.generate();
    const p = join(dir, 'json.key');
    writeFileSync(p, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
    expect(loadKeypair(p).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });
});

describe('amount formatting is exact (no float drift)', () => {
  it('formats SOL', () => {
    expect(fmtSol(BigInt(LAMPORTS_PER_SOL))).toBe('1');
    expect(fmtSol(1_500_000_000n)).toBe('1.5');
    expect(fmtSol(1n)).toBe('0.000000001');
    expect(fmtSol(0n)).toBe('0');
  });

  it('formats token amounts at arbitrary decimals', () => {
    expect(fmtAmount(1_000_000n, 6)).toBe('1');
    expect(fmtAmount(1_234_567n, 6)).toBe('1.234567');
    expect(fmtAmount(10n, 0)).toBe('10');
  });

  it('keeps a sane dust reserve', () => {
    expect(SOL_DUST_RESERVE).toBeGreaterThan(0n);
    expect(fmtSol(SOL_DUST_RESERVE)).toBe('0.002');
  });
});
