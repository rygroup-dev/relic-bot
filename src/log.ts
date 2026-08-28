/**
 * Structured logging with mandatory secret redaction.
 *
 * Every log line passes through `redact` before it is emitted. Private keys,
 * JWTs and API keys must never reach stdout, a log file, or Telegram.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = (process.env.LOG_LEVEL as Level) ?? 'info';
export function setLogLevel(l: Level): void {
  threshold = l;
}

/** Patterns for material that must never be printed. */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<jwt:redacted>'],
  // provider API keys
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '<apikey:redacted>'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, '<apikey:redacted>'],
  // Telegram bot tokens
  [/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, '<tgtoken:redacted>'],
  // base58 blobs long enough to be a 64-byte secret key
  [/\b[1-9A-HJ-NP-Za-km-z]{80,}\b/g, '<secret:redacted>'],
  // JSON secret-key arrays
  [/\[(?:\s*\d{1,3}\s*,){60,}\s*\d{1,3}\s*\]/g, '<secret:redacted>'],
];

export function redact(input: unknown): string {
  let s = typeof input === 'string' ? input : safeStringify(input);
  for (const [re, replacement] of SECRET_PATTERNS) s = s.replace(re, replacement);
  return s;
}

function safeStringify(v: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(v, (_k, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (val instanceof Uint8Array) return '<bytes:redacted>';
      if (val && typeof val === 'object') {
        if (seen.has(val as object)) return '<circular>';
        seen.add(val as object);
      }
      return val;
    }) ?? String(v);
  } catch {
    return String(v);
  }
}

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${redact(msg)}`;
  const out = extra === undefined ? line : `${line} ${redact(extra)}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(out);
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(sub: string): Logger;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
    child: (sub) => logger(`${scope}:${sub}`),
  };
}
