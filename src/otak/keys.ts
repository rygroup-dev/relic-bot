/**
 * Encrypted storage for Otak provider API keys.
 *
 * Keys arrive over Telegram, so they must not sit in plaintext on disk. They
 * are sealed with AES-256-GCM under a machine-local secret that is generated
 * once at 0600. This protects against casual disclosure (backups, log
 * scraping, a shared box); it is not protection against root on this host,
 * which by definition can read the process memory anyway.
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scryptSync,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type ProviderName = 'openai' | 'anthropic' | 'fugu';

interface Sealed {
  v: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

function secretPath(dataDir: string): string {
  return join(dataDir, '.otak-secret');
}
function storePath(dataDir: string): string {
  return join(dataDir, 'otak-keys.json.enc');
}

function ensureDir(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
}

function machineSecret(dataDir: string): Buffer {
  const p = secretPath(dataDir);
  ensureDir(p);
  if (existsSync(p)) return Buffer.from(readFileSync(p, 'utf8').trim(), 'hex');
  const s = randomBytes(32);
  writeFileSync(p, s.toString('hex'), { mode: 0o600 });
  chmodSync(p, 0o600);
  return s;
}

export class OtakKeyStore {
  private cache: Partial<Record<ProviderName, string>> | null = null;

  constructor(private readonly dataDir: string) {}

  private seal(obj: Partial<Record<ProviderName, string>>): Sealed {
    const salt = randomBytes(16);
    const key = scryptSync(machineSecret(this.dataDir), salt, 32);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return {
      v: 1,
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      tag: c.getAuthTag().toString('hex'),
      data: data.toString('hex'),
    };
  }

  private open(s: Sealed): Partial<Record<ProviderName, string>> {
    const key = scryptSync(machineSecret(this.dataDir), Buffer.from(s.salt, 'hex'), 32);
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'hex'));
    d.setAuthTag(Buffer.from(s.tag, 'hex'));
    const out = Buffer.concat([d.update(Buffer.from(s.data, 'hex')), d.final()]);
    return JSON.parse(out.toString('utf8'));
  }

  all(): Partial<Record<ProviderName, string>> {
    if (this.cache) return this.cache;
    const p = storePath(this.dataDir);
    if (!existsSync(p)) return (this.cache = {});
    try {
      this.cache = this.open(JSON.parse(readFileSync(p, 'utf8')) as Sealed);
    } catch {
      // A corrupt or foreign-machine store must not crash the bot.
      this.cache = {};
    }
    return this.cache;
  }

  get(provider: ProviderName): string | null {
    // An env var always wins, so a deployment can inject keys without Telegram.
    const envName =
      provider === 'openai'
        ? 'OPENAI_API_KEY'
        : provider === 'anthropic'
          ? 'ANTHROPIC_API_KEY'
          : 'FUGU_API_KEY';
    const fromEnv = process.env[envName];
    if (fromEnv) return fromEnv;
    return this.all()[provider] ?? null;
  }

  set(provider: ProviderName, key: string): void {
    const next = { ...this.all(), [provider]: key };
    const p = storePath(this.dataDir);
    ensureDir(p);
    writeFileSync(p, JSON.stringify(this.seal(next)), { mode: 0o600 });
    chmodSync(p, 0o600);
    this.cache = next;
  }

  clear(provider: ProviderName): void {
    const next = { ...this.all() };
    delete next[provider];
    const p = storePath(this.dataDir);
    ensureDir(p);
    writeFileSync(p, JSON.stringify(this.seal(next)), { mode: 0o600 });
    this.cache = next;
  }

  /** Which providers have a usable key, without revealing any of them. */
  configured(): ProviderName[] {
    return (['openai', 'anthropic', 'fugu'] as const).filter((p) => this.get(p) !== null);
  }
}
