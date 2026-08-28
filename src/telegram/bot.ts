/**
 * Telegram control surface.
 *
 * Locked to an owner allowlist: every other chat is dropped silently. Nothing
 * secret is ever echoed except an explicit, confirmed private-key export, which
 * is auto-deleted from the chat afterwards.
 *
 * Anything that moves funds runs dry-first and requires a second confirmation
 * tap before it broadcasts.
 */

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { join } from 'node:path';
import type { Fleet } from '../fleet/orchestrator.js';
import type { Config } from '../config.js';
import { OtakKeyStore, type ProviderName } from '../otak/keys.js';
import { OpenAIProvider } from '../otak/providers/openai.js';
import { AnthropicProvider } from '../otak/providers/anthropic.js';
import { FuguProvider } from '../otak/providers/fugu.js';
import {
  createWallet,
  createWallets,
  MAX_BULK_MINT,
  importWallet,
  exportWalletJson,
  fleetMembers,
  resolveMain,
  persistMainAccount,
  persistEnvValue,
} from '../wallet/manage.js';
import { Treasury, type SweepReport, type FleetMember } from '../wallet/treasury.js';
import { RELIC_MINT } from '../protocol/endpoints.js';
import { CLASSES, CLASS_ICON, type ClassId } from '../protocol/messages.js';
import { RestClient } from '../net/rest.js';
import { AuthClient } from '../auth/client.js';
import { loadAccount } from '../wallet/keystore.js';
import { generateName } from '../game/names.js';
import { onboardBatch } from '../game/onboard.js';
import { loadFleet } from '../wallet/keystore.js';
import { readRelicBalance } from '../economy/gate.js';
import * as ui from './ui.js';
import { redact, logger } from '../log.js';

const log = logger('telegram');
const PROVIDERS: ProviderName[] = ['openai', 'anthropic', 'fugu'];

/** Seconds an exported private key stays visible in the chat. */
const EXPORT_TTL_S = 90;

type Pending =
  | { kind: 'otak-key'; provider: ProviderName }
  | { kind: 'import-wallet' }
  | { kind: 'character-name'; walletId: string; classId: ClassId };

export interface TelegramOptions {
  token: string;
  /** Mutated in place when ownership is claimed on first contact. */
  ownerIds: number[];
  cfg: Config;
}

export class ControlBot {
  private bot: Bot;
  private keys: OtakKeyStore;
  private pending = new Map<number, Pending>();
  /** Last suggested hero name per wallet+class, so a tap confirms what was shown. */
  private suggested = new Map<string, string>();
  /**
   * Wallet ids from the most recent mint, per chat.
   *
   * Bulk job assignment targets these rather than the whole fleet: logging into
   * every wallet to discover it already has a character wastes the auth quota,
   * which is the scarcest resource here.
   */
  private lastMinted = new Map<number, string[]>();

  constructor(
    private readonly opts: TelegramOptions,
    private readonly fleet: Fleet,
  ) {
    this.bot = new Bot(opts.token);
    this.keys = new OtakKeyStore(opts.cfg.RELIC_DATA_DIR);
    this.wire();
  }

  // ---------------------------------------------------------------- infra --

  private get cfg(): Config {
    return this.opts.cfg;
  }

  /**
   * First-contact ownership claim.
   *
   * A fresh install has no owner id, and an empty allowlist must mean nobody
   * rather than everybody — otherwise the whole control surface would be open
   * to any stranger who found the bot. So instead of opening up, the FIRST
   * person to talk to the bot claims it permanently, and everyone after that
   * is refused.
   *
   * The claim is written straight to .env so it survives a restart. To hand the
   * bot to someone else, clear TELEGRAM_OWNER_IDS and restart.
   */
  private claimIfUnowned(ctx: Context): boolean {
    if (this.opts.ownerIds.length > 0) return false;
    const id = ctx.from?.id;
    if (id === undefined) return false;

    this.opts.ownerIds.push(id);
    try {
      persistEnvValue(join(process.cwd(), '.env'), 'TELEGRAM_OWNER_IDS', String(id));
    } catch (e) {
      log.warn(`could not persist the owner id: ${(e as Error).message}`);
    }
    log.info(
      `ownership claimed by telegram user ${id} (${ctx.from?.username ?? 'no username'}) ` +
        `— every other chat is now refused`,
    );
    return true;
  }

  private isOwner(ctx: Context): boolean {
    const id = ctx.from?.id;
    if (id === undefined) return false;
    if (this.opts.ownerIds.length === 0) return false;
    return this.opts.ownerIds.includes(id);
  }

  private connection(): Connection {
    return new Connection(
      process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
      'confirmed',
    );
  }

  private treasury(): Treasury {
    const members = fleetMembers(this.cfg.RELIC_KEYS_DIR);
    const main = resolveMain(members, this.cfg.RELIC_MAIN_ACCOUNT);
    return new Treasury({
      connection: this.connection(),
      fleet: members,
      mainAddress: main.address,
      maxFundLamports: BigInt(Math.round(this.cfg.GAS_MAX_SOL * LAMPORTS_PER_SOL)),
    });
  }

  private static menu(): InlineKeyboard {
    return new InlineKeyboard()
      .text('⚔️ Fleet', 'nav:status')
      .text('💰 Holdings', 'nav:holdings')
      .row()
      .text('👛 Wallets', 'nav:wallets')
      .text('🔒 Gate', 'nav:gate')
      .row()
      .text('🎭 Characters', 'nav:chars')
      .text('🧠 Otak', 'nav:otak')
      .row()
      .text('🅿️ Parks', 'nav:parks')
      .text('🔄 Refresh', 'nav:menu')
      .row()
      .text('🧹 Sweep', 'tre:sweep:dry')
      .text('⛽ Fund gas', 'tre:fund:dry');
  }

  private static backRow(kb = new InlineKeyboard()): InlineKeyboard {
    return kb.row().text('‹ Menu', 'nav:menu');
  }

  /** Reply to a tap by editing in place where possible, else sending fresh. */
  private async show(
    ctx: Context,
    text: string,
    kb: InlineKeyboard = ControlBot.backRow(),
  ): Promise<void> {
    // Telegram rejects anything over 4096 chars outright, so every view is
    // trimmed at a line boundary rather than failing to send at all.
    const body = ui.fit(text);
    const payload = { parse_mode: 'HTML' as const, reply_markup: kb };
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(body, payload);
        return;
      } catch {
        // Editing fails when the content is identical or too old; fall through.
      }
    }
    await ctx.reply(body, payload);
  }

  // ---------------------------------------------------------------- views --

  private async viewStatus(ctx: Context): Promise<void> {
    await this.show(
      ctx,
      ui.renderStatus(this.fleet.status()),
      ControlBot.backRow(new InlineKeyboard().text('🔄 Refresh', 'nav:status')),
    );
  }

  private async viewParks(ctx: Context): Promise<void> {
    const active = this.fleet.parks.active();
    const kb = new InlineKeyboard();
    if (active.length > 0) kb.text('🔓 Clear all parks', 'park:clear').row();
    await this.show(ctx, ui.renderParks(active), ControlBot.backRow(kb));
  }

  private async viewGate(ctx: Context): Promise<void> {
    const rows = this.fleet.status().map((r) => ({
      id: r.id,
      address: r.address,
      allowed: r.gate ? r.gate.allowed : null,
      relicBaseUnits: r.gate ? r.gate.relicBaseUnits : null,
    }));
    await this.show(
      ctx,
      ui.renderGate(rows),
      ControlBot.backRow(new InlineKeyboard().text('🔄 Refresh', 'nav:gate')),
    );
  }

  private async viewWallets(ctx: Context): Promise<void> {
    let members: FleetMember[];
    try {
      members = fleetMembers(this.cfg.RELIC_KEYS_DIR);
    } catch {
      // No keys yet is a normal first-run state, not an error to surface.
      members = [];
    }
    const mainAddr = members.length
      ? resolveMain(members, this.cfg.RELIC_MAIN_ACCOUNT).address
      : '';

    const kb = new InlineKeyboard()
      .text('✨ Mint + job', 'wal:mintjob')
      .row()
      .text('➕ 1', 'wal:mint:1')
      .text('➕ 5', 'wal:mint:5')
      .text(`➕ ${MAX_BULK_MINT}`, `wal:mint:${MAX_BULK_MINT}`)
      .row()
      .text('📥 Import key', 'wal:import')
      .row();
    if (members.length > 0) {
      kb.text('⭐ Set main', 'wal:main').text('🔑 Export key', 'wal:export').row();
    }

    // Read each wallet's own live state rather than showing a flat list: the
    // fleet already knows each one's phase and whether it is stuck without a job.
    const live = new Map(this.fleet.status().map((r) => [r.id, r]));

    await this.show(
      ctx,
      ui.renderWallets(
        members.map((m) => {
          const st = live.get(m.id);
          const row: ui.WalletRow = {
            id: m.id,
            address: m.address,
            isMain: m.address === mainAddr,
          };
          if (st) {
            row.phase = st.phase;
            // `no_character` is reported through the park note, so a wallet
            // that never got a job is visible without an extra round trip.
            if (/no_character|no job/i.test(st.note)) row.hasCharacter = false;
          }
          return row;
        }),
      ),
      ControlBot.backRow(kb),
    );
  }

  private async viewHoldings(ctx: Context): Promise<void> {
    await this.show(ctx, '<i>Reading balances from chain…</i>', new InlineKeyboard());
    try {
      const t = this.treasury();
      const rows = [];
      for (const m of fleetMembers(this.cfg.RELIC_KEYS_DIR)) {
        const sol = await t.solBalance(m.address);
        const tokens = (await t.tokenHoldings(m.address)).map((h) => ({
          mint: h.mint,
          amount: h.amount,
          decimals: h.decimals,
          ...(h.mint === RELIC_MINT ? { label: 'RELIC' } : {}),
        }));
        rows.push({ id: m.id, address: m.address, isMain: m.address === t.main.address, sol, tokens });
      }
      await this.show(
        ctx,
        ui.renderHoldings(rows),
        ControlBot.backRow(
          new InlineKeyboard().text('🔄 Refresh', 'nav:holdings').text('🧹 Sweep', 'tre:sweep:dry'),
        ),
      );
    } catch (err) {
      await this.show(ctx, `⚠️ ${ui.esc((err as Error).message)}`);
    }
  }

  private async viewOtak(ctx: Context): Promise<void> {
    const kb = new InlineKeyboard()
      .text(this.fleet.otak.enabled ? '⚫ Turn OFF' : '🟢 Turn ON', 'otak:toggle')
      .text('🩺 Health', 'otak:health')
      .row()
      .text('🔑 OpenAI', 'otak:key:openai')
      .text('🔑 Anthropic', 'otak:key:anthropic')
      .row()
      .text('🔑 Fugu', 'otak:key:fugu')
      .row()
      .text('📊 What it decided', 'otak:decisions');

    await this.show(
      ctx,
      ui.renderOtak({
        enabled: this.fleet.otak.enabled,
        configured: this.keys.configured(),
        health: this.fleet.otak.healthSnapshot(),
        preferred: this.cfg.OTAK_PROVIDER,
      }),
      ControlBot.backRow(kb),
    );
  }

  // ------------------------------------------------------------ characters --

  /** A short-lived authenticated session for one wallet, for REST-only work. */
  private async sessionFor(walletId: string) {
    const rest = new RestClient(this.cfg.RELIC_BASE_URL);
    const auth = new AuthClient(rest);
    const account = loadAccount(join(this.cfg.RELIC_KEYS_DIR, `${walletId}.key`));
    const session = await auth.login(account);
    return { auth, session, account };
  }

  private async viewCharacterWallets(ctx: Context): Promise<void> {
    let members: FleetMember[];
    try {
      members = fleetMembers(this.cfg.RELIC_KEYS_DIR);
    } catch {
      members = [];
    }
    if (members.length === 0) {
      await this.show(ctx, '<b>🎭 Characters</b>\n\nNo wallets yet — create one first.');
      return;
    }
    const kb = new InlineKeyboard();
    for (const m of members) kb.text(`👛 ${m.id}`, `chr:w:${m.id}`).row();
    await this.show(
      ctx,
      '<b>🎭 Characters</b>\n\nPick a wallet to see its roster.\n\n' +
        '<i>A wallet with no character cannot enter the world at all —</i>\n' +
        '<i>the server refuses the join with no_character.</i>',
      ControlBot.backRow(kb),
    );
  }

  private async viewCharacters(ctx: Context, walletId: string): Promise<void> {
    await this.show(ctx, '<i>Loading roster and balance…</i>', new InlineKeyboard());
    try {
      const { auth, session, account } = await this.sessionFor(walletId);
      const { characters, unlocks } = await auth.roster(session.token);

      // Detect the wallet's actual on-chain RELIC, so a locked class can say
      // how far off it is rather than just "locked".
      const relic = await readRelicBalance(this.connection(), account.address).catch(() => null);

      const owned = new Map(characters.map((c) => [String(c.classId ?? ''), c]));
      const rows = CLASSES.map((classId) => {
        const c = owned.get(classId);
        const row: ui.CharacterRow = {
          classId,
          icon: CLASS_ICON[classId],
          owned: Boolean(c),
          unlocked: unlocks.length === 0 ? true : unlocks.includes(classId),
        };
        if (c?.name) row.name = c.name;
        if (typeof c?.level === 'number') row.level = c.level;
        return row;
      });

      const kb = new InlineKeyboard();
      for (const r of rows) {
        if (r.owned) continue;
        kb.text(
          `${r.icon} ${r.classId}${r.unlocked ? ' 🆓' : ' 🔒'}`,
          `chr:pick:${walletId}:${r.classId}`,
        ).row();
      }
      kb.text('🔄 Refresh', `chr:w:${walletId}`).text('‹ Wallets', 'nav:chars').row();

      await this.show(
        ctx,
        ui.renderCharacters(walletId, rows, { address: account.address, relicBaseUnits: relic }),
        ControlBot.backRow(kb),
      );
    } catch (err) {
      await this.show(ctx, `⚠️ ${ui.esc((err as Error).message)}`);
    }
  }

  /** Give every character-less wallet the same job, each with its own name. */
  /**
   * Onboard a named set of wallets, reporting progress as it goes.
   *
   * Shared by the plain "pick a job" path and the combined mint+job path so
   * both behave identically.
   */
  private async onboardAccounts(
    ctx: Context,
    walletIds: readonly string[],
    classId: ClassId | undefined,
    minted?: readonly { id: string; address: string }[],
  ): Promise<void> {
    const wanted = new Set(walletIds);
    const accounts = loadFleet(this.cfg.RELIC_KEYS_DIR).filter((a) => wanted.has(a.id));
    if (accounts.length === 0) {
      await this.show(ctx, '<b>🎭</b> No wallets to assign.', ControlBot.backRow());
      return;
    }

    const rest = new RestClient(this.cfg.RELIC_BASE_URL);
    const auth = new AuthClient(rest);
    const prefix = minted ? ui.renderMinted(minted) + '\n\n' : '';

    let last = 0;
    const results = await onboardBatch(auth, accounts, {
      ...(classId ? { classId } : {}),
      taken: new Set<string>(),
      onProgress: async (done, total) => {
        if (Date.now() - last < 3000 && done !== total) return;
        last = Date.now();
        await this.show(
          ctx,
          `${prefix}<i>Creating heroes… ${done}/${total}</i>`,
          new InlineKeyboard(),
        ).catch(() => {});
      },
    });

    await this.show(
      ctx,
      prefix + ui.renderOnboard(results),
      ControlBot.backRow(
        new InlineKeyboard()
          .text('🎭 Characters', 'nav:chars')
          .text('🔓 Clear parks', 'park:clear')
          .row()
          .text('🔑 Back up keys', 'wal:export'),
      ),
    );
  }

  private async bulkOnboard(ctx: Context, classId: ClassId): Promise<void> {
    try {
      // Prefer the wallets just minted; fall back to the whole fleet only when
      // there is no recent mint to scope to. Logging into wallets that already
      // have a character just to discover that wastes the scarce auth quota.
      const scoped = this.lastMinted.get(ctx.chat!.id);
      const ids =
        scoped && scoped.length > 0
          ? scoped
          : loadFleet(this.cfg.RELIC_KEYS_DIR).map((a) => a.id);
      await this.onboardAccounts(ctx, ids, classId);
    } catch (err) {
      await this.show(ctx, `⚠️ ${ui.esc((err as Error).message)}`);
    }
  }

  /** Class chosen: offer a generated name, or let the operator type one. */
  private async viewNamePick(ctx: Context, walletId: string, classId: ClassId): Promise<void> {
    const suggested = generateName(classId);
    this.suggested.set(`${walletId}:${classId}`, suggested);

    await this.show(
      ctx,
      [
        `<b>${CLASS_ICON[classId]} ${ui.esc(classId)} — ${ui.esc(walletId)}</b>`,
        '',
        'Suggested name:',
        `<b>${ui.esc(suggested)}</b>`,
        '',
        '⚠️ <b>The name is permanent.</b> The game does not allow renaming.',
      ].join('\n'),
      ControlBot.backRow(
        new InlineKeyboard()
          .text('✅ Use this name', `chr:go:${walletId}:${classId}`)
          .row()
          .text('🎲 Another', `chr:pick:${walletId}:${classId}`)
          .text('✏️ Type my own', `chr:new:${walletId}:${classId}`)
          .row()
          .text('‹ Roster', `chr:w:${walletId}`),
      ),
    );
  }

  private async createCharacter(
    ctx: Context,
    walletId: string,
    classId: ClassId,
    name: string,
  ): Promise<void> {
    const trimmed = name.replace(/\s+/g, ' ').trim();
    if (trimmed.length < 2 || trimmed.length > 20) {
      await ctx.reply('Name must be 2–20 characters. Nothing was created.', {
        parse_mode: 'HTML',
        reply_markup: ControlBot.backRow(),
      });
      return;
    }

    try {
      const { auth, session } = await this.sessionFor(walletId);
      const created = await auth.createCharacter(session.token, classId, trimmed);
      await ctx.reply(
        [
          `<b>✅ ${CLASS_ICON[classId]} ${ui.esc(classId)} created</b>`,
          '',
          `wallet: <b>${ui.esc(walletId)}</b>`,
          `name: <b>${ui.esc(created?.name ?? trimmed)}</b>`,
          '',
          'Clear the park on this wallet and it will enter the world.',
        ].join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: ControlBot.backRow(
            new InlineKeyboard()
              .text('🔓 Clear parks', 'park:clear')
              .text('🎭 Roster', `chr:w:${walletId}`),
          ),
        },
      );
    } catch (err) {
      const m = (err as Error).message;
      // Translate the server's own vocabulary rather than showing a raw code.
      const friendly =
        /token_required/.test(m)
          ? '🔒 That class needs RELIC held on this wallet.'
          : /classExists|exists/.test(m)
            ? `You already have a ${classId} on this wallet.`
            : ui.esc(m);
      await ctx.reply(`⚠️ ${friendly}`, {
        parse_mode: 'HTML',
        reply_markup: ControlBot.backRow(new InlineKeyboard().text('🎭 Roster', `chr:w:${walletId}`)),
      });
    }
  }

  // ------------------------------------------------------------- treasury --

  private async runTreasury(ctx: Context, op: 'sweep' | 'fund', execute: boolean): Promise<void> {
    await this.show(
      ctx,
      execute ? '<i>Broadcasting…</i>' : '<i>Simulating…</i>',
      new InlineKeyboard(),
    );
    try {
      const t = this.treasury();
      let report: SweepReport;
      let title: string;

      if (op === 'sweep') {
        report = await t.sweepAll({
          dryRun: !execute,
          includeSol: this.cfg.SWEEP_INCLUDE_SOL,
        });
        title = `Collecting into <b>${ui.esc(t.main.id)}</b>\n\n`;
      } else {
        const min = BigInt(Math.round(this.cfg.GAS_MIN_SOL * LAMPORTS_PER_SOL));
        const top = BigInt(Math.round(this.cfg.GAS_TOPUP_SOL * LAMPORTS_PER_SOL));
        report = await t.fundGas(min, top, { dryRun: !execute });
        title = `Topping up from <b>${ui.esc(t.main.id)}</b>\n\n`;
      }

      const kb = new InlineKeyboard();
      if (!execute && report.transfers.length > 0) {
        kb.text('✅ Confirm and send', `tre:${op}:go`).row();
      }
      await this.show(ctx, title + ui.renderSweepReport(report, !execute), ControlBot.backRow(kb));
    } catch (err) {
      await this.show(ctx, `⚠️ ${ui.esc((err as Error).message)}`);
    }
  }

  // -------------------------------------------------------------- wiring --

  private wire(): void {
    this.bot.use(async (ctx, next) => {
      const claimed = this.claimIfUnowned(ctx);
      if (!this.isOwner(ctx)) return; // silent drop for everyone else
      if (claimed) {
        await ctx.reply(
          [
            '<b>👋 Bot claimed</b>',
            '',
            `You are now the owner (id <code>${ctx.from!.id}</code>).`,
            'Everyone else is ignored from here on.',
            '',
            '<i>Saved to .env, so this survives a restart.</i>',
          ].join('\n'),
          { parse_mode: 'HTML' },
        );
      }
      await next();
    });

    const menu = async (ctx: Context): Promise<void> => {
      await this.show(ctx, ui.HELP, ControlBot.menu());
    };

    this.bot.command(['start', 'help', 'menu'], menu);
    this.bot.command('status', (ctx) => this.viewStatus(ctx));
    this.bot.command('parks', (ctx) => this.viewParks(ctx));
    this.bot.command('gate', (ctx) => this.viewGate(ctx));
    this.bot.command('wallets', (ctx) => this.viewWallets(ctx));
    this.bot.command('holdings', (ctx) => this.viewHoldings(ctx));
    this.bot.command('otak', (ctx) => this.viewOtak(ctx));
    this.bot.command('decisions', async (ctx) => {
      await this.show(
        ctx,
        ui.renderDecisions(this.fleet.otak.recentDecisions(8), this.fleet.otak.stats()),
        ControlBot.backRow(new InlineKeyboard().text('🧠 Otak', 'nav:otak')),
      );
    });
    this.bot.command('characters', (ctx) => this.viewCharacterWallets(ctx));
    this.bot.command('sweep', (ctx) => this.runTreasury(ctx, 'sweep', false));
    this.bot.command('fund', (ctx) => this.runTreasury(ctx, 'fund', false));

    // ---- navigation -------------------------------------------------------
    this.bot.callbackQuery(/^nav:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const where = ctx.match![1];
      if (where === 'menu') return menu(ctx);
      if (where === 'status') return this.viewStatus(ctx);
      if (where === 'parks') return this.viewParks(ctx);
      if (where === 'gate') return this.viewGate(ctx);
      if (where === 'wallets') return this.viewWallets(ctx);
      if (where === 'holdings') return this.viewHoldings(ctx);
      if (where === 'otak') return this.viewOtak(ctx);
      if (where === 'chars') return this.viewCharacterWallets(ctx);
    });

    this.bot.callbackQuery('park:clear', async (ctx) => {
      const n = this.fleet.parks.unparkAll();
      await ctx.answerCallbackQuery({ text: `cleared ${n}` });
      return this.viewParks(ctx);
    });

    // ---- treasury ---------------------------------------------------------
    this.bot.callbackQuery(/^tre:(sweep|fund):(dry|go)$/, async (ctx) => {
      const op = ctx.match![1] as 'sweep' | 'fund';
      const mode = ctx.match![2];
      await ctx.answerCallbackQuery();
      return this.runTreasury(ctx, op, mode === 'go');
    });

    // ---- wallets ----------------------------------------------------------
    // ---- mint + job in one action ----------------------------------------
    this.bot.callbackQuery('wal:mintjob', async (ctx) => {
      await ctx.answerCallbackQuery();
      const kb = new InlineKeyboard();
      for (const c of CLASSES) kb.text(`${CLASS_ICON[c]} ${c}`, `wal:mj:${c}`).row();
      await this.show(
        ctx,
        [
          '<b>✨ Mint wallets with a job</b>',
          '',
          'Pick the job first, then how many wallets.',
          'Each one is created, given a hero, and ready to play.',
          '',
          '⚠️ Hero names are permanent; each gets its own generated name.',
        ].join('\n'),
        ControlBot.backRow(kb),
      );
    });

    this.bot.callbackQuery(/^wal:mj:([a-z]+)$/, async (ctx) => {
      const classId = ctx.match![1] as ClassId;
      await ctx.answerCallbackQuery();
      const kb = new InlineKeyboard()
        .text('1', `wal:mjgo:${classId}:1`)
        .text('3', `wal:mjgo:${classId}:3`)
        .text('5', `wal:mjgo:${classId}:5`)
        .text(`${MAX_BULK_MINT}`, `wal:mjgo:${classId}:${MAX_BULK_MINT}`)
        .row();
      await this.show(
        ctx,
        `<b>${CLASS_ICON[classId]} ${ui.esc(classId)}</b>\n\nHow many wallets?\n\n` +
          `<i>Creation is paced — auth rate-limits, so a large batch takes a while.</i>`,
        ControlBot.backRow(kb),
      );
    });

    this.bot.callbackQuery(/^wal:mjgo:([a-z]+):(\d+)$/, async (ctx) => {
      const classId = ctx.match![1] as ClassId;
      const n = Number(ctx.match![2]);
      await ctx.answerCallbackQuery({ text: `minting ${n}…` });
      try {
        const made =
          n === 1
            ? [createWallet(this.cfg.RELIC_KEYS_DIR)]
            : createWallets(this.cfg.RELIC_KEYS_DIR, n);
        this.lastMinted.set(ctx.chat!.id, made.map((w) => w.id));

        await this.show(
          ctx,
          ui.renderMinted(made) + `\n\n<i>Creating ${ui.esc(classId)} heroes…</i>`,
          new InlineKeyboard(),
        );
        await this.onboardAccounts(ctx, made.map((w) => w.id), classId, made);
      } catch (err) {
        await this.show(ctx, `⚠️ ${ui.esc((err as Error).message)}`);
      }
    });

    this.bot.callbackQuery(/^wal:mint:(\d+)$/, async (ctx) => {
      const n = Number(ctx.match![1]);
      await ctx.answerCallbackQuery({ text: `minting ${n}…` });
      try {
        const made = n === 1
          ? [createWallet(this.cfg.RELIC_KEYS_DIR)]
          : createWallets(this.cfg.RELIC_KEYS_DIR, n);

        this.lastMinted.set(ctx.chat!.id, made.map((w) => w.id));

        const kb = new InlineKeyboard();
        if (made.length > 1) {
          kb.text(`🎯 One job for all ${made.length}`, 'chr:bulkpick').row();
        }
        for (const w of made) kb.text(`🎭 ${w.id}`, `chr:w:${w.id}`).row();
        kb.text('🔑 Back up keys', 'wal:export').row();

        await this.show(
          ctx,
          ui.renderMinted(made) +
            '\n\n<b>Next: give each wallet a job.</b>\n' +
            '<i>A wallet without a character cannot enter the world.</i>' +
            (made.length > 1
              ? '\n<i>Pick one job for all of them, or choose per wallet.</i>'
              : ''),
          ControlBot.backRow(kb),
        );
      } catch (err) {
        await this.show(ctx, `⚠️ ${ui.esc((err as Error).message)}`);
      }
    });

    this.bot.callbackQuery('wal:import', async (ctx) => {
      await ctx.answerCallbackQuery();
      this.pending.set(ctx.chat!.id, { kind: 'import-wallet' });
      await this.show(
        ctx,
        [
          '<b>📥 Import a wallet</b>',
          '',
          'Send the secret key as your next message.',
          '',
          'Accepted formats:',
          '• base58 string (Phantom → Export Private Key)',
          '• JSON array of 64 numbers (solana-keygen)',
          '',
          '<i>Your message is deleted the moment it arrives.</i>',
        ].join('\n'),
        ControlBot.backRow(),
      );
    });

    this.bot.callbackQuery('wal:main', async (ctx) => {
      await ctx.answerCallbackQuery();
      const members = fleetMembers(this.cfg.RELIC_KEYS_DIR);
      const kb = new InlineKeyboard();
      for (const m of members) {
        const data = `wal:setmain:${m.id}`;
        if (ui.callbackFits(data)) kb.text(m.id, data).row();
      }
      await this.show(
        ctx,
        '<b>⭐ Choose the main account</b>\n\nSweeps collect into this wallet, and gas is funded from it.',
        ControlBot.backRow(kb),
      );
    });

    this.bot.callbackQuery(/^wal:setmain:(.+)$/, async (ctx) => {
      const id = ctx.match![1]!;
      try {
        const members = fleetMembers(this.cfg.RELIC_KEYS_DIR);
        const chosen = resolveMain(members, id);
        persistMainAccount(join(process.cwd(), '.env'), chosen.id);
        // Update the live config so the change takes effect without a restart.
        this.cfg.RELIC_MAIN_ACCOUNT = chosen.id;
        await ctx.answerCallbackQuery({ text: `main = ${chosen.id}` });
        await this.show(
          ctx,
          [
            '<b>⭐ Main account updated</b>',
            '',
            `Now: <b>${ui.esc(chosen.id)}</b>`,
            ui.code(chosen.address),
            '',
            'Saved to <code>.env</code> and applied immediately.',
          ].join('\n'),
          ControlBot.backRow(new InlineKeyboard().text('👛 Wallets', 'nav:wallets')),
        );
      } catch (err) {
        await ctx.answerCallbackQuery({ text: 'failed' });
        await this.show(ctx, `⚠️ ${ui.esc((err as Error).message)}`);
      }
    });

    this.bot.callbackQuery('wal:export', async (ctx) => {
      await ctx.answerCallbackQuery();
      const members = fleetMembers(this.cfg.RELIC_KEYS_DIR);
      const kb = new InlineKeyboard();
      for (const m of members) {
        const data = `wal:exp:${m.id}`;
        if (ui.callbackFits(data)) kb.text(`🔑 ${m.id}`, data).row();
      }
      await this.show(
        ctx,
        [
          '<b>🔑 Export a private key</b>',
          '',
          '⚠️ <b>Read this first.</b>',
          'The key will appear in this chat as JSON. Anyone who sees it',
          'controls that wallet completely and irreversibly.',
          '',
          `The message is deleted automatically after <b>${EXPORT_TTL_S}s</b>, but`,
          'Telegram may keep it in backups. Do not forward it.',
          '',
          'Choose a wallet:',
        ].join('\n'),
        ControlBot.backRow(kb),
      );
    });

    this.bot.callbackQuery(/^wal:exp:(.+)$/, async (ctx) => {
      const id = ctx.match![1]!;
      await ctx.answerCallbackQuery();
      try {
        const e = exportWalletJson(this.cfg.RELIC_KEYS_DIR, id);
        await this.show(
          ctx,
          `<b>🔑 ${ui.esc(e.id)}</b>\n${ui.code(e.address)}\n\n<i>Key sent below; it self-deletes.</i>`,
          ControlBot.backRow(new InlineKeyboard().text('👛 Wallets', 'nav:wallets')),
        );

        const msg = await ctx.reply(
          `<pre>${ui.esc(e.json)}</pre>`,
          { parse_mode: 'HTML' },
        );
        const chatId = ctx.chat!.id;
        setTimeout(() => {
          void ctx.api.deleteMessage(chatId, msg.message_id).catch(() => {
            log.warn('could not auto-delete an exported key — tell the operator to remove it');
          });
        }, EXPORT_TTL_S * 1000);
      } catch (err) {
        await this.show(ctx, `⚠️ ${ui.esc((err as Error).message)}`);
      }
    });

    // ---- characters -------------------------------------------------------
    this.bot.callbackQuery(/^chr:w:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      return this.viewCharacters(ctx, ctx.match![1]!);
    });

    this.bot.callbackQuery('chr:bulkpick', async (ctx) => {
      await ctx.answerCallbackQuery();
      const targets = this.lastMinted.get(ctx.chat!.id) ?? [];
      const scope = targets.length > 0 ? `${targets.length} newly minted wallet` : 'every wallet';

      const kb = new InlineKeyboard();
      for (const c of CLASSES) kb.text(`${CLASS_ICON[c]} ${c}`, `chr:bulkgo:${c}`).row();
      await this.show(
        ctx,
        [
          `<b>🎯 One job for ${ui.esc(scope)}${targets.length > 1 ? 's' : ''}</b>`,
          '',
          'Each hero still gets its own generated name.',
          '',
          '⚠️ Names are permanent.',
          '<i>🔒 classes are refused on wallets that lack the RELIC —</i>',
          '<i>those are reported individually, the rest still succeed.</i>',
        ].join('\n'),
        ControlBot.backRow(kb),
      );
    });

    this.bot.callbackQuery(/^chr:bulkgo:(.+)$/, async (ctx) => {
      const classId = ctx.match![1] as ClassId;
      await ctx.answerCallbackQuery({ text: 'creating…' });
      await this.bulkOnboard(ctx, classId);
    });

    this.bot.callbackQuery(/^chr:pick:([^:]+):(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      return this.viewNamePick(ctx, ctx.match![1]!, ctx.match![2] as ClassId);
    });

    this.bot.callbackQuery(/^chr:go:([^:]+):(.+)$/, async (ctx) => {
      const walletId = ctx.match![1]!;
      const classId = ctx.match![2] as ClassId;
      await ctx.answerCallbackQuery({ text: 'creating…' });
      const name = this.suggested.get(`${walletId}:${classId}`) ?? generateName(classId);
      await this.createCharacter(ctx, walletId, classId, name);
    });

    this.bot.callbackQuery(/^chr:new:([^:]+):(.+)$/, async (ctx) => {
      const walletId = ctx.match![1]!;
      const classId = ctx.match![2] as ClassId;
      await ctx.answerCallbackQuery();
      this.pending.set(ctx.chat!.id, { kind: 'character-name', walletId, classId });
      await this.show(
        ctx,
        [
          `<b>${CLASS_ICON[classId] ?? '🎭'} New ${ui.esc(classId)} — ${ui.esc(walletId)}</b>`,
          '',
          'Send the hero name as your next message.',
          '',
          '2–20 characters, letters, numbers and spaces.',
          '',
          '⚠️ <b>The name is permanent.</b> The game does not allow renaming.',
        ].join('\n'),
        ControlBot.backRow(),
      );
    });

    // ---- otak -------------------------------------------------------------
    this.bot.callbackQuery('otak:toggle', async (ctx) => {
      this.rebuildProviders();
      const next = !this.fleet.otak.enabled;
      this.fleet.otak.setEnabled(next);

      // Persist it. The toggle used to live only in memory, so any restart
      // silently turned the brain back off while the operator believed it was
      // still on — a setting you cannot trust is worse than no setting.
      try {
        persistEnvValue(join(process.cwd(), '.env'), 'OTAK_ENABLED', String(next));
        this.cfg.OTAK_ENABLED = next;
      } catch (e) {
        log.warn(`could not persist the otak toggle: ${(e as Error).message}`);
      }

      await ctx.answerCallbackQuery({ text: next ? 'Otak ON' : 'Otak OFF' });
      return this.viewOtak(ctx);
    });

    this.bot.callbackQuery('otak:decisions', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.show(
        ctx,
        ui.renderDecisions(this.fleet.otak.recentDecisions(8), this.fleet.otak.stats()),
        ControlBot.backRow(
          new InlineKeyboard()
            .text('🔄 Refresh', 'otak:decisions')
            .text('🧠 Otak', 'nav:otak'),
        ),
      );
    });

    this.bot.callbackQuery('otak:health', async (ctx) => {
      await ctx.answerCallbackQuery({ text: 'probing…' });
      this.rebuildProviders();
      if (this.keys.configured().length === 0) {
        await this.show(
          ctx,
          '<b>🧠 Otak</b>\n\nNo provider keys are set.\nThe bot is running on deterministic heuristics.',
          ControlBot.backRow(new InlineKeyboard().text('🧠 Otak', 'nav:otak')),
        );
        return;
      }
      await this.fleet.otak.checkHealth();
      return this.viewOtak(ctx);
    });

    this.bot.callbackQuery(/^otak:key:(openai|anthropic|fugu)$/, async (ctx) => {
      const p = ctx.match![1] as ProviderName;
      await ctx.answerCallbackQuery();
      this.pending.set(ctx.chat!.id, { kind: 'otak-key', provider: p });
      await this.show(
        ctx,
        [
          `<b>🔑 ${ui.esc(p)} API key</b>`,
          '',
          'Send the key as your next message.',
          '',
          '<i>Your message is deleted immediately, and the key is stored',
          'encrypted (AES-256-GCM) at 0600 on this server.</i>',
        ].join('\n'),
        ControlBot.backRow(),
      );
    });

    // ---- pending free-text input -----------------------------------------
    this.bot.on('message:text', async (ctx) => {
      const p = this.pending.get(ctx.chat.id);
      if (!p) return;
      this.pending.delete(ctx.chat.id);

      const text = ctx.message.text.trim();
      // Delete the secret from the chat before doing anything else with it.
      try {
        await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
      } catch {
        log.warn('could not delete an inbound secret message');
      }

      if (p.kind === 'otak-key') {
        if (text.length < 8) {
          await ctx.reply('That does not look like an API key — nothing stored.', {
            parse_mode: 'HTML',
            reply_markup: ControlBot.backRow(),
          });
          return;
        }
        this.keys.set(p.provider, text);
        this.rebuildProviders();
        const provider = this.buildProvider(p.provider);
        const h = provider ? await provider.health() : { ok: false, detail: 'not constructed' };
        await ctx.reply(
          [
            `<b>🔑 ${ui.esc(p.provider)} key stored</b>`,
            '',
            `Health: ${h.ok ? '✅ OK' : '❌ FAILED'}`,
            `<i>${ui.esc(redact(h.detail).slice(0, 160))}</i>`,
          ].join('\n'),
          { parse_mode: 'HTML', reply_markup: ControlBot.backRow(new InlineKeyboard().text('🧠 Otak', 'nav:otak')) },
        );
        return;
      }

      if (p.kind === 'character-name') {
        await this.createCharacter(ctx, p.walletId, p.classId, text);
        return;
      }

      // import-wallet
      try {
        const w = importWallet(this.cfg.RELIC_KEYS_DIR, text);
        await ctx.reply(
          [
            '<b>✅ Wallet imported</b>',
            '',
            `id: <b>${ui.esc(w.id)}</b>`,
            `address: ${ui.code(w.address)}`,
            '',
            'Restart the bot to include it in the running fleet.',
          ].join('\n'),
          { parse_mode: 'HTML', reply_markup: ControlBot.backRow(new InlineKeyboard().text('👛 Wallets', 'nav:wallets')) },
        );
      } catch (err) {
        await ctx.reply(`⚠️ ${ui.esc((err as Error).message)}`, {
          parse_mode: 'HTML',
          reply_markup: ControlBot.backRow(),
        });
      }
    });

    this.bot.catch((err) => {
      log.error(`bot error: ${redact(err.message)}`);
    });
  }

  // ----------------------------------------------------------- providers --

  private buildProvider(p: ProviderName) {
    const key = this.keys.get(p);
    if (!key) return null;
    if (p === 'openai') return new OpenAIProvider({ apiKey: key });
    if (p === 'anthropic') {
      const o: ConstructorParameters<typeof AnthropicProvider>[0] = { apiKey: key };
      if (process.env.OTAK_ANTHROPIC_MODEL) o.model = process.env.OTAK_ANTHROPIC_MODEL;
      const e = process.env.OTAK_ANTHROPIC_EFFORT;
      if (e === 'low' || e === 'medium' || e === 'high' || e === 'xhigh' || e === 'max') o.effort = e;
      return new AnthropicProvider(o);
    }
    const o: ConstructorParameters<typeof FuguProvider>[0] = { apiKey: key };
    if (process.env.FUGU_BASE_URL) o.baseUrl = process.env.FUGU_BASE_URL;
    if (process.env.FUGU_MODEL) o.model = process.env.FUGU_MODEL;
    return new FuguProvider(o);
  }

  /** Rebuild the fallback chain, preferred provider first. */
  rebuildProviders(): void {
    const preferred = this.cfg.OTAK_PROVIDER;
    const order = [preferred, ...PROVIDERS.filter((p) => p !== preferred)];
    const built = order.map((p) => this.buildProvider(p)).filter((p) => p !== null);
    this.fleet.otak.setProviders(built as NonNullable<(typeof built)[number]>[]);
  }

  // --------------------------------------------------------------- alerts --

  async notify(text: string): Promise<void> {
    for (const id of this.opts.ownerIds) {
      try {
        await this.bot.api.sendMessage(id, redact(text), {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('⚔️ Fleet', 'nav:status')
            .text('🅿️ Parks', 'nav:parks'),
        });
      } catch (e) {
        log.warn(`notify ${id} failed: ${(e as Error).message}`);
      }
    }
  }

  async start(): Promise<void> {
    this.rebuildProviders();
    // Use the pre-rendered text: it carries the wallet id, which a bare
    // "reached level 7" across seventeen wallets does not.
    this.fleet.onAlert((a) => this.notify(a.formatted ?? `${a.kind}: ${a.text}`));
    await this.bot.api.setMyCommands([
      { command: 'menu', description: 'Main menu' },
      { command: 'status', description: 'Fleet status' },
      { command: 'holdings', description: 'SOL and token balances' },
      { command: 'wallets', description: 'Create, import, export wallets' },
      { command: 'sweep', description: 'Collect tokens into the main wallet' },
      { command: 'fund', description: 'Top up wallets low on gas' },
      { command: 'gate', description: 'Token-gate state' },
      { command: 'characters', description: 'Roster and hero creation' },
      { command: 'otak', description: 'The LLM brain' },
      { command: 'decisions', description: 'What the brain actually decided' },
      { command: 'parks', description: 'What is blocked, and why' },
    ]);
    void this.bot.start({ onStart: () => log.info('telegram control bot online') });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
