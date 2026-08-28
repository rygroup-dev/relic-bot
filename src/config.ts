/**
 * Configuration. Every value has a safe default; nothing here enables spending,
 * because no spending code exists.
 */
import 'dotenv/config';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(v)));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().finite());

const Schema = z.object({
  RELIC_BASE_URL: z.string().url().default('https://playrelic.gg'),
  RELIC_KEYS_DIR: z.string().default('/root/.relic-bot/keys'),
  RELIC_DATA_DIR: z.string().default('/root/relic-bot/data'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // --- fleet pacing ---
  FLEET_MAX_CONCURRENT: num(10),
  FLEET_START_STAGGER_MS: num(20_000),
  ACTION_TEMPO_MS: num(1_400),
  ACTION_JITTER_PCT: num(35),

  // --- liveness watchdog (output-based, not error-based) ---
  WATCHDOG_SILENCE_MIN: num(25),

  // --- selling ---
  SELL_ENABLED: bool(true),
  SELL_MIN_NET_MICRO_USDC: num(50_000), // ignore loot worth < $0.05 net
  SELL_CURRENCY_PREFERENCE: z.enum(['auto', 'usdc', 'relic']).default('auto'),
  /** How much extra return RELIC must offer to justify its volatility vs USDC. */
  RELIC_VOLATILITY_DISCOUNT_PCT: num(8),

  // --- Otak ---
  OTAK_ENABLED: bool(false),
  OTAK_PROVIDER: z.enum(['openai', 'anthropic', 'fugu']).default('anthropic'),
  OTAK_TIMEOUT_MS: num(20_000),
  OTAK_MAX_CALLS_PER_HOUR: num(60),

  // --- Telegram ---
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_OWNER_IDS: z.string().optional(),
});

export type Config = z.infer<typeof Schema> & { ownerIds: number[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid configuration:\n${issues}`);
  }
  const ownerIds = (parsed.data.TELEGRAM_OWNER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);

  return { ...parsed.data, ownerIds };
}
