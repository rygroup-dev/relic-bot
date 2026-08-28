/**
 * ============================================================================
 *  THE PAYMENT HARD-LOCK
 * ============================================================================
 *
 * This module is the ONLY place in relic-bot that touches a private key.
 *
 * It exports exactly one signing capability: signing the game's UTF-8 login
 * message. It does NOT export -- and does not contain -- any means of building,
 * serialising, or signing a Solana `Transaction`.
 *
 * Why this matters
 * ----------------
 * Gameplay (`i.move`, `i.attack`, `i.loot.pickup`, ...) travels over the
 * Colyseus WebSocket and needs no signature at all. Selling on the marketplace
 * (`POST /api/marketplace/listings`) is REST + Bearer and needs no signature.
 * Only *buying* requires a signed transaction.
 *
 * Therefore: an attacker with full control of this process still cannot move
 * funds, because the code to do so does not exist. This is strictly stronger
 * than an env flag or a spend cap, both of which are merely data an attacker
 * could change.
 *
 * An ed25519 signature over the login message cannot authorise a transfer:
 * the Solana runtime only accepts signatures over serialised transaction
 * messages, and this text is not one. `assertLoginMessage` additionally
 * refuses anything that does not match the login template exactly, so the
 * primitive cannot be repurposed by a caller.
 *
 * DO NOT add transaction signing here. If buying is ever required, it belongs
 * in a separate, explicitly reviewed module (`src/wallet/spender.ts`) that is
 * absent by design.
 */

import nacl from 'tweetnacl';
import type { Keypair } from '@solana/web3.js';

/** First line of the login message. Em dash is U+2014, as in the client. */
export const LOGIN_HEADER = 'Relic — sign in';
export const LOGIN_TRAILER = 'Only sign this on the official Relic site.';

/** The four-line login message, verbatim from the production client. */
export function buildLoginMessage(walletAddress: string, timestamp: number): string {
  return [
    LOGIN_HEADER,
    `Wallet: ${walletAddress}`,
    `Timestamp: ${timestamp}`,
    LOGIN_TRAILER,
  ].join('\n');
}

/** Thrown when a caller attempts to sign anything other than a login message. */
export class RefusedToSignError extends Error {
  constructor(reason: string) {
    super(`refused to sign: ${reason}`);
    this.name = 'RefusedToSignError';
  }
}

/**
 * Guard: refuse any payload that is not exactly a well-formed login message.
 *
 * Solana transaction messages are compact binary blobs beginning with a
 * signature count and header bytes; they are not text starting with our
 * literal prefix. Requiring the exact template makes it impossible to smuggle
 * a transaction through this function.
 */
export function assertLoginMessage(message: unknown): asserts message is string {
  if (typeof message !== 'string') {
    throw new RefusedToSignError('payload is not a string');
  }
  if (!message.startsWith(LOGIN_HEADER + '\n')) {
    throw new RefusedToSignError('payload is not a Relic login message');
  }
  if (!message.endsWith(LOGIN_TRAILER)) {
    throw new RefusedToSignError('login message trailer missing or altered');
  }
  const lines = message.split('\n');
  if (lines.length !== 4) {
    throw new RefusedToSignError(`login message must be 4 lines, got ${lines.length}`);
  }
  if (!lines[1]?.startsWith('Wallet: ') || !lines[2]?.startsWith('Timestamp: ')) {
    throw new RefusedToSignError('login message field order altered');
  }
}

/**
 * A wallet that can prove ownership of an address and nothing else.
 *
 * The secret key is held in a closure and never exposed as a property, so it
 * cannot be read off the object by other code, serialised into a log line, or
 * accidentally included in an LLM prompt.
 */
export interface LoginSigner {
  readonly address: string;
  /** Signs the login message, returning a base64 signature (client uses btoa). */
  signLoginMessage(message: string): string;
}

export function createLoginSigner(keypair: Keypair): LoginSigner {
  const secret = Uint8Array.from(keypair.secretKey);
  const address = keypair.publicKey.toBase58();

  return Object.freeze({
    address,
    signLoginMessage(message: string): string {
      assertLoginMessage(message);
      const bytes = new TextEncoder().encode(message);
      const sig = nacl.sign.detached(bytes, secret);
      // The client encodes with btoa(String.fromCharCode(...sig)) => base64.
      return Buffer.from(sig).toString('base64');
    },
  });
}

/**
 * Declared capability surface. The test suite asserts this list never grows,
 * which turns "we must not add transaction signing" into an enforced invariant
 * rather than a comment somebody can ignore.
 */
export const SIGNING_CAPABILITIES = Object.freeze(['login-message'] as const);
