/**
 * Telegram control surface.
 *
 * Locked to an owner allowlist: every other chat is ignored silently. The bot
 * never prints a private key, a JWT, or an API key — `redact()` in log.ts is
 * applied to anything echoed back.
 */

import { Bot, type Context } from 'grammy';
import type { Fleet } from '../fleet/orchestrator.js';
import { OtakKeyStore, type ProviderName } from '../otak/keys.js';
import { OpenAIProvider } from '../otak/providers/openai.js';
import { AnthropicProvider } from '../otak/providers/anthropic.js';
import { FuguProvider } from '../otak/providers/fugu.js';
import { formatRelic } from '../economy/gate.js';
import { redact, logger } from '../log.js';

const log = logger('telegram');

const PROVIDERS: ProviderName[] = ['openai', 'anthropic', 'fugu'];

export interface TelegramOptions {
  token: string;
  ownerIds: number[];
  dataDir: string;
}

export class ControlBot {
  private bot: Bot;
  private keys: OtakKeyStore;
  /** Chats currently expected to send an API key as their next message. */
  private awaitingKey = new Map<number, ProviderName>();

  constructor(
    private readonly opts: TelegramOptions,
    private readonly fleet: Fleet,
  ) {
    this.bot = new Bot(opts.token);
    this.keys = new OtakKeyStore(opts.dataDir);
    this.wire();
  }

  private isOwner(ctx: Context): boolean {
    const id = ctx.from?.id;
    if (id === undefined) return false;
    // An empty allowlist would otherwise mean "everyone"; refuse instead.
    if (this.opts.ownerIds.length === 0) return false;
    return this.opts.ownerIds.includes(id);
  }

  private wire(): void {
    this.bot.use(async (ctx, next) => {
      if (!this.isOwner(ctx)) return; // silent drop
      await next();
    });

    this.bot.command('start', (ctx) =>
      ctx.reply(
        [
          'relic-bot control',
          '',
          '/status  — fleet status',
          '/parks   — active parks',
          '/unpark  — clear all parks',
          '/gate    — token-gate + RELIC balance per wallet',
          '/otak    — LLM brain: providers, keys, on/off',
          '/health  — probe every configured provider',
          '',
          'Payments are hard-locked: this bot can sell but never buy.',
        ].join('\n'),
      ),
    );

    this.bot.command('status', async (ctx) => {
      const rows = this.fleet.status();
      if (rows.length === 0) return ctx.reply('no accounts running');
      const lines = rows.map((r) => {
        const age =
          r.lastValueAt === 0
            ? 'never'
            : `${Math.round((Date.now() - r.lastValueAt) / 60_000)}m ago`;
        return (
          `${r.id} [${r.phase}] gate=${r.gate ? (r.gate.allowed ? 'open' : 'CLOSED') : '?'} ` +
          `battles=${r.battles} listed=${r.listings} lastValue=${age}\n  ${r.note}`
        );
      });
      return ctx.reply(redact(lines.join('\n')));
    });

    this.bot.command('parks', (ctx) => {
      const active = this.fleet.parks.active();
      if (active.length === 0) return ctx.reply('no active parks');
      return ctx.reply(
        redact(
          active
            .map(
              (p) =>
                `${p.scope}${p.accountId ? `/${p.accountId}` : ''} "${p.key}": ${p.reason}` +
                (Number.isFinite(p.until)
                  ? ` (${Math.max(0, Math.round((p.until - Date.now()) / 1000))}s left)`
                  : ' (indefinite)'),
            )
            .join('\n'),
        ),
      );
    });

    this.bot.command('unpark', (ctx) => {
      const n = this.fleet.parks.unparkAll();
      return ctx.reply(`cleared ${n} park entr${n === 1 ? 'y' : 'ies'}`);
    });

    this.bot.command('gate', (ctx) => {
      const rows = this.fleet.status();
      if (rows.length === 0) return ctx.reply('no accounts running');
      return ctx.reply(
        rows
          .map((r) => {
            const g = r.gate;
            const bal =
              g?.relicBaseUnits === null || g?.relicBaseUnits === undefined
                ? 'unknown'
                : `${formatRelic(g.relicBaseUnits)} RELIC`;
            return `${r.id}: gate=${g ? (g.allowed ? 'OPEN' : 'CLOSED') : 'unchecked'} balance=${bal}`;
          })
          .join('\n') +
          '\n\nNote: the gate threshold is server-side and is not published; ' +
          'this reports what the server actually answered.',
      );
    });

    this.bot.command('otak', async (ctx) => {
      const arg = (ctx.match ?? '').toString().trim();
      const configured = this.keys.configured();

      if (arg === 'on' || arg === 'off') {
        this.rebuildProviders();
        this.fleet.otak.setEnabled(arg === 'on');
        return ctx.reply(`otak ${arg}${arg === 'on' && configured.length === 0 ? ' (no keys set — heuristics only)' : ''}`);
      }

      if (arg.startsWith('key ')) {
        const p = arg.slice(4).trim() as ProviderName;
        if (!PROVIDERS.includes(p)) return ctx.reply(`unknown provider: ${p}`);
        this.awaitingKey.set(ctx.chat.id, p);
        return ctx.reply(
          `Send the ${p} API key as your next message.\n` +
            `I will delete your message immediately and store the key encrypted.`,
        );
      }

      if (arg.startsWith('clear ')) {
        const p = arg.slice(6).trim() as ProviderName;
        if (!PROVIDERS.includes(p)) return ctx.reply(`unknown provider: ${p}`);
        this.keys.clear(p);
        this.rebuildProviders();
        return ctx.reply(`cleared ${p} key`);
      }

      return ctx.reply(
        [
          `otak: ${this.fleet.otak.enabled ? 'ON' : 'OFF'}`,
          `keys set: ${configured.length ? configured.join(', ') : '(none)'}`,
          '',
          'With no key, the bot still plays fully on deterministic heuristics.',
          'With a key, the brain re-ranks the same candidates — it can never',
          'invent an action, and it can never unlock a payment.',
          '',
          '/otak on | off',
          '/otak key openai | anthropic | fugu',
          '/otak clear <provider>',
          '/health',
        ].join('\n'),
      );
    });

    this.bot.command('health', async (ctx) => {
      this.rebuildProviders();
      if (this.keys.configured().length === 0) {
        return ctx.reply('no provider keys set — running on heuristics only');
      }
      await ctx.reply('probing providers…');
      const health = await this.fleet.otak.checkHealth();
      return ctx.reply(
        health.map((h) => `${h.name}: ${h.ok ? 'OK' : 'FAILED'} — ${redact(h.detail)}`).join('\n'),
      );
    });

    // Capture an API key sent as a plain message, then delete it from the chat.
    this.bot.on('message:text', async (ctx) => {
      const pending = this.awaitingKey.get(ctx.chat.id);
      if (!pending) return;
      this.awaitingKey.delete(ctx.chat.id);

      const key = ctx.message.text.trim();
      try {
        await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
      } catch {
        log.warn('could not delete the key message — ask the operator to remove it manually');
      }

      if (!key || key.length < 8) return ctx.reply('that does not look like an API key — nothing stored');

      this.keys.set(pending, key);
      this.rebuildProviders();
      const provider = this.buildProvider(pending);
      const h = provider ? await provider.health() : { ok: false, detail: 'not constructed' };
      return ctx.reply(
        `${pending} key stored (encrypted).\nhealth: ${h.ok ? 'OK' : 'FAILED'} — ${redact(h.detail)}`,
      );
    });
  }

  private buildProvider(p: ProviderName) {
    const key = this.keys.get(p);
    if (!key) return null;
    if (p === 'openai') return new OpenAIProvider({ apiKey: key });
    if (p === 'anthropic') {
      const opts: ConstructorParameters<typeof AnthropicProvider>[0] = { apiKey: key };
      if (process.env.OTAK_ANTHROPIC_MODEL) opts.model = process.env.OTAK_ANTHROPIC_MODEL;
      const e = process.env.OTAK_ANTHROPIC_EFFORT;
      if (e === 'low' || e === 'medium' || e === 'high' || e === 'xhigh' || e === 'max') {
        opts.effort = e;
      }
      return new AnthropicProvider(opts);
    }
    const opts: ConstructorParameters<typeof FuguProvider>[0] = { apiKey: key };
    if (process.env.FUGU_BASE_URL) opts.baseUrl = process.env.FUGU_BASE_URL;
    if (process.env.FUGU_MODEL) opts.model = process.env.FUGU_MODEL;
    return new FuguProvider(opts);
  }

  /** Rebuild the provider chain, preferred provider first. */
  rebuildProviders(): void {
    const preferred = (process.env.OTAK_PROVIDER as ProviderName) ?? 'anthropic';
    const order = [preferred, ...PROVIDERS.filter((p) => p !== preferred)];
    const built = order.map((p) => this.buildProvider(p)).filter((p) => p !== null);
    this.fleet.otak.setProviders(built as NonNullable<(typeof built)[number]>[]);
  }

  async notify(text: string): Promise<void> {
    for (const id of this.opts.ownerIds) {
      try {
        await this.bot.api.sendMessage(id, redact(text));
      } catch (e) {
        log.warn(`notify ${id} failed: ${(e as Error).message}`);
      }
    }
  }

  async start(): Promise<void> {
    this.rebuildProviders();
    this.fleet.onAlert((a) => this.notify(`[${a.kind.toUpperCase()}] ${a.text}`));
    void this.bot.start({ onStart: () => log.info('telegram control bot online') });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
