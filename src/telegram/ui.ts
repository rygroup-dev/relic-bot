/**
 * Presentation helpers for the Telegram surface.
 *
 * Kept separate from the command wiring so the formatting can be unit-tested
 * without a bot token, and so message layout stays consistent everywhere.
 *
 * All output is HTML parse mode. Any value that could contain user or server
 * text is escaped before it reaches a message.
 */

import type { AccountStatus } from '../fleet/account.js';
import type { ParkEntry } from '../safety/park.js';
import type { SweepReport } from '../wallet/treasury.js';
import { fmtAmount, fmtSol } from '../wallet/treasury.js';
import { formatRelic } from '../economy/gate.js';

/**
 * Telegram hard limits. A message over 4096 characters is rejected outright,
 * and callback_data over 64 bytes is silently truncated by the client — both
 * surface only once a fleet grows, which is exactly when you least want the
 * control surface to break.
 */
export const TG_MAX_MESSAGE = 4096;
export const TG_MAX_CALLBACK = 64;

/**
 * Trim a rendered view to fit, cutting at a line boundary and saying how much
 * was hidden rather than letting Telegram reject the whole message.
 */
export function fit(text: string, limit = TG_MAX_MESSAGE): string {
  if (text.length <= limit) return text;
  const notice = '\n\n<i>… truncated — use the CLI for the full list.</i>';
  const budget = limit - notice.length;
  const cut = text.slice(0, budget);
  const lastBreak = cut.lastIndexOf('\n');
  return (lastBreak > budget * 0.6 ? cut.slice(0, lastBreak) : cut) + notice;
}

/** True when callback data is short enough for Telegram to round-trip intact. */
export function callbackFits(data: string): boolean {
  return Buffer.byteLength(data, 'utf8') <= TG_MAX_CALLBACK;
}

/** Escape the five characters Telegram's HTML mode treats specially. */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function code(s: unknown): string {
  return `<code>${esc(s)}</code>`;
}

/** Shorten an address for display without losing recognisability. */
export function shortAddr(a: string): string {
  return a.length <= 12 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export function relTime(ts: number, now = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Consistent chrome so every view reads as one product, not ten screens. */
export const RULE = '━━━━━━━━━━━━━━━';

export function header(icon: string, title: string, subtitle?: string): string[] {
  const out = [`${icon}  <b>${esc(title)}</b>`];
  if (subtitle) out.push(`<i>${esc(subtitle)}</i>`);
  out.push(RULE);
  return out;
}

export function footnote(...lines: string[]): string[] {
  return [RULE, ...lines.map((l) => `<i>${l}</i>`)];
}

const PHASE_ICON: Record<string, string> = {
  idle: '⚪',
  authenticating: '🔑',
  connecting: '🔌',
  playing: '🟢',
  parked: '🟡',
  banned: '🔴',
  stopped: '⚫',
};

export function phaseIcon(phase: string): string {
  return PHASE_ICON[phase] ?? '⚪';
}

/** A small text meter. Reads at a glance in a chat window. */
export function bar(cur: number | null, max: number | null, width = 10): string {
  if (cur === null || max === null || max <= 0) return '·'.repeat(width);
  const frac = Math.max(0, Math.min(1, cur / max));
  const filled = Math.round(frac * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function pct(cur: number | null, max: number | null): string {
  if (cur === null || max === null || max <= 0) return '?';
  return `${Math.round((cur / max) * 100)}%`;
}

export interface Vitals {
  hp: number | null;
  maxHp: number | null;
  mana: number | null;
  maxMana: number | null;
  level: number | null;
  gold: number | null;
  depth: number | null;
}

/** HP and Mana are the only pools this game has — no stamina or energy. */
export function renderVitals(v: Vitals | undefined | null, indent = '     '): string[] {
  // A wallet that has not joined a room yet has no vitals at all; that is a
  // normal state, not a reason to fail rendering the whole fleet view.
  if (!v) return [];
  const out: string[] = [];
  if (v.hp !== null || v.maxHp !== null) {
    out.push(`${indent}❤️ ${bar(v.hp, v.maxHp)} ${esc(pct(v.hp, v.maxHp))}` +
      (v.hp !== null && v.maxHp !== null ? `  <i>${v.hp}/${v.maxHp}</i>` : ''));
  }
  if (v.mana !== null || v.maxMana !== null) {
    out.push(`${indent}🔷 ${bar(v.mana, v.maxMana)} ${esc(pct(v.mana, v.maxMana))}` +
      (v.mana !== null && v.maxMana !== null ? `  <i>${v.mana}/${v.maxMana}</i>` : ''));
  }
  const meta: string[] = [];
  if (v.level !== null) meta.push(`⭐ lv${v.level}`);
  if (v.depth !== null) meta.push(`🕳 depth ${v.depth}`);
  if (v.gold !== null) meta.push(`🪙 ${v.gold}`);
  if (meta.length > 0) out.push(`${indent}${meta.join('   ')}`);
  return out;
}

/** The fleet overview. */
export function renderStatus(rows: readonly AccountStatus[], now = Date.now()): string {
  if (rows.length === 0) {
    return (
      '<b>⚔️ Fleet</b>\n\nNo accounts are running.\n\n' +
      'Add one from <b>👛 Wallets</b>, then give it a job.'
    );
  }

  const playing = rows.filter((r) => r.phase === 'playing').length;
  const parked = rows.filter((r) => r.phase === 'parked').length;
  const banned = rows.filter((r) => r.phase === 'banned').length;
  const battles = rows.reduce((s, r) => s + r.battles, 0);
  const listed = rows.reduce((s, r) => s + r.listings, 0);

  const out: string[] = [
    ...header('⚔️', 'Fleet', `${rows.length} wallet${rows.length === 1 ? '' : 's'} under management`),
    '',
    `🟢 <b>${playing}</b> playing   🟡 <b>${parked}</b> parked` +
      (banned ? `   🔴 <b>${banned}</b> banned` : ''),
    `⚔️ <b>${battles}</b> battles   🏷️ <b>${listed}</b> listed`,
  ];

  for (const r of rows) {
    const gate = r.gate === null ? '❔' : r.gate.allowed ? '🔓' : '🔒';
    out.push(
      '',
      `${phaseIcon(r.phase)} <b>${esc(r.id)}</b>  ·  ${esc(r.phase)}  ·  ${gate}`,
      `     ${code(shortAddr(r.address))}`,
      `     ⚔️ ${r.battles}   🏷️ ${r.listings}   ⏱ ${esc(relTime(r.lastValueAt, now))}`,
      ...renderVitals(r.vitals),
    );
    if (r.note) out.push(`     <i>${esc(r.note.slice(0, 110))}</i>`);
  }

  out.push(
    '',
    ...footnote('Liveness is measured by produced value,', 'never by the absence of errors.'),
  );
  return out.join('\n');
}

export function renderParks(entries: readonly ParkEntry[], now = Date.now()): string {
  if (entries.length === 0) {
    return '<b>🅿️ Parks</b>\n\nNothing is parked. All wallets are free to work.';
  }
  const out = ['<b>🅿️ Active parks</b>', ''];
  for (const p of entries) {
    const scope = p.scope === 'fleet' ? '🌐 FLEET' : `👤 ${esc(p.accountId ?? '?')}`;
    const left = Number.isFinite(p.until)
      ? `${Math.max(0, Math.round((p.until - now) / 1000))}s left`
      : 'indefinite';
    out.push(
      `${p.needsOperator ? '⚠️' : '•'} ${scope} — ${code(p.key)}`,
      `   ${esc(p.reason.slice(0, 160))}`,
      `   <i>${esc(left)}</i>`,
      '',
    );
  }
  out.push('<i>A fleet park blocks every wallet, not just the one that hit it.</i>');
  return out.join('\n');
}

export interface GateRow {
  id: string;
  address: string;
  allowed: boolean | null;
  relicBaseUnits: bigint | null;
}

export function renderGate(rows: readonly GateRow[]): string {
  if (rows.length === 0) return '<b>🔒 Token gate</b>\n\nNo accounts running.';
  const out = ['<b>🔒 Token gate</b>', ''];
  for (const r of rows) {
    const icon = r.allowed === null ? '❔' : r.allowed ? '🔓' : '🔒';
    const state = r.allowed === null ? 'unchecked' : r.allowed ? 'OPEN' : 'CLOSED';
    const bal = r.relicBaseUnits === null ? 'unknown' : `${formatRelic(r.relicBaseUnits)} RELIC`;
    out.push(`${icon} <b>${esc(r.id)}</b> — ${esc(state)}`, `   holding ${esc(bal)}`, '');
  }
  out.push(
    '<i>Playing works while the gate is closed; market features do not.</i>',
    '<i>The threshold is enforced server-side and is not published, so this</i>',
    '<i>shows what the server actually answered.</i>',
  );
  return out.join('\n');
}

export interface HoldingRow {
  id: string;
  address: string;
  isMain: boolean;
  sol: bigint;
  tokens: { mint: string; amount: bigint; decimals: number; label?: string }[];
}

export function renderHoldings(rows: readonly HoldingRow[]): string {
  const out = [...header('💰', 'Holdings', 'read live from chain')];
  for (const r of rows) {
    out.push(
      '',
      `${r.isMain ? '⭐' : '👛'} <b>${esc(r.id)}</b>${r.isMain ? '  <i>main</i>' : ''}`,
      `     ${code(shortAddr(r.address))}`,
      `     ◎ <b>${esc(fmtSol(r.sol))}</b> SOL`,
    );
    if (r.tokens.length === 0) {
      out.push('     <i>no tokens</i>');
    } else {
      for (const t of r.tokens) {
        out.push(
          `     💎 <b>${esc(fmtAmount(t.amount, t.decimals))}</b> ${esc(t.label ?? shortAddr(t.mint))}`,
        );
      }
    }
  }
  out.push('', ...footnote('Sweeps move everything into ⭐.'));
  return out.join('\n');
}

export function renderSweepReport(r: SweepReport, dry: boolean): string {
  const out = [`<b>${dry ? '🧪 Sweep — dry run' : '✅ Sweep executed'}</b>`, ''];

  if (r.transfers.length === 0) {
    out.push('Nothing to move.');
  } else {
    for (const t of r.transfers) {
      const label = t.mint === 'SOL' ? '◎ SOL' : shortAddr(t.mint);
      out.push(
        `• <b>${esc(t.wallet)}</b> → main` +
          `\n   ${esc(fmtAmount(t.amount, t.decimals))} ${esc(label)}` +
          (t.signature ? `\n   ${code(t.signature.slice(0, 20) + '…')}` : ''),
      );
    }
  }

  if (r.skipped.length > 0) {
    out.push('', '<i>Skipped:</i>');
    for (const s of r.skipped) out.push(`   ${esc(s.wallet)} — ${esc(s.reason)}`);
  }
  if (r.errors.length > 0) {
    out.push('', '<b>⚠️ Errors:</b>');
    for (const e of r.errors) out.push(`   ${esc(e.wallet)} — ${esc(e.error.slice(0, 140))}`);
  }
  if (dry && r.transfers.length > 0) {
    out.push('', '<i>Nothing was broadcast. Confirm below to send for real.</i>');
  }
  return out.join('\n');
}

export interface OtakView {
  enabled: boolean;
  configured: string[];
  health: { name: string; ok: boolean; detail: string; checkedAt: number }[];
  preferred: string;
}

export function renderOtak(v: OtakView): string {
  const out = [
    '<b>🧠 Otak — the decision brain</b>',
    '',
    `Status: <b>${v.enabled ? '🟢 ON' : '⚫ OFF'}</b>`,
    `Preferred provider: <b>${esc(v.preferred)}</b>`,
    `Keys stored: ${v.configured.length ? `<b>${esc(v.configured.join(', '))}</b>` : '<i>none</i>'}`,
    '',
  ];

  if (v.health.length > 0) {
    out.push('<b>Provider health</b>');
    for (const h of v.health) {
      out.push(
        `${h.ok ? '✅' : '❌'} <b>${esc(h.name)}</b> — ${esc(h.detail.slice(0, 80))}` +
          ` <i>(${esc(relTime(h.checkedAt))})</i>`,
      );
    }
    out.push('');
  }

  out.push(
    '───────────────',
    'With no key the bot still plays fully on deterministic heuristics.',
    'With a key, the brain <b>re-ranks the same candidates</b> — it can never',
    'invent an action, and it can never unlock a payment.',
  );
  return out.join('\n');
}

export interface WalletRow {
  id: string;
  address: string;
  isMain: boolean;
  /** Live phase from the running fleet, when this wallet is being run. */
  phase?: string;
  /** Whether the fleet has seen a character for it. */
  hasCharacter?: boolean;
}

export function renderWallets(rows: readonly WalletRow[]): string {
  if (rows.length === 0) {
    return [
      ...header('👛', 'Wallets', 'none yet'),
      '',
      'Mint one with <b>➕</b>, or bring your own with <b>📥 Import</b>.',
      '',
      ...footnote('Keys are written 0600 into a 0700 directory,', 'outside the repository.'),
    ].join('\n');
  }

  const out = [
    ...header('👛', 'Wallets', `${rows.length} loaded`),
  ];

  for (const r of rows) {
    const mark = r.isMain ? '⭐' : '👛';
    const bits: string[] = [];
    if (r.phase) bits.push(`${phaseIcon(r.phase)} ${r.phase}`);
    if (r.hasCharacter === false) bits.push('🎭 no job');
    out.push(
      '',
      `${mark} <b>${esc(r.id)}</b>${r.isMain ? '  <i>main</i>' : ''}`,
      `     ${code(r.address)}`,
    );
    if (bits.length > 0) out.push(`     ${esc(bits.join('  ·  '))}`);
  }

  out.push(
    '',
    ...footnote(
      '⭐ is the main account — sweeps collect here',
      'and gas is funded from it.',
    ),
  );
  return out.join('\n');
}

/** Freshly minted wallets, with the backup warning that must accompany them. */
export function renderMinted(
  made: readonly { id: string; address: string }[],
): string {
  const out = [
    `<b>✅ ${made.length} wallet${made.length === 1 ? '' : 's'} created</b>`,
    '',
  ];
  for (const w of made) {
    out.push(`🆕 <b>${esc(w.id)}</b>`, `   ${code(w.address)}`);
  }
  out.push(
    '',
    '───────────────',
    'Keys are stored at <code>0600</code> on this server.',
    '',
    '⚠️ <b>Back them up now.</b> If this server is lost and you have no',
    'copy, these wallets are gone permanently — nobody can recover them.',
    '',
    'Restart the bot to include them in the running fleet.',
  );
  return out.join('\n');
}

/** Result of auto-creating heroes for freshly minted wallets. */
export function renderOnboard(
  results: readonly {
    walletId: string;
    ok: boolean;
    classId?: string;
    name?: string;
    reason?: string;
    alreadyHad?: boolean;
  }[],
): string {
  const good = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const out = [`<b>🎭 Heroes: ${good.length}/${results.length} ready</b>`, ''];

  for (const r of good) {
    out.push(
      `✅ <b>${esc(r.walletId)}</b> — ${esc(r.classId ?? '?')} ` +
        `“<b>${esc(r.name ?? '?')}</b>”${r.alreadyHad ? ' <i>(existing)</i>' : ''}`,
    );
  }
  for (const r of bad) {
    out.push(`⚠️ <b>${esc(r.walletId)}</b> — ${esc((r.reason ?? 'failed').slice(0, 110))}`);
  }

  if (good.length > 0) {
    out.push('', '<i>Tap Clear parks and these wallets will enter the world.</i>');
  }
  if (bad.some((r) => /RELIC/i.test(r.reason ?? ''))) {
    out.push('', '<i>🔒 means that class needs RELIC held on that wallet.</i>');
  }
  return out.join('\n');
}

export interface CharacterRow {
  classId: string;
  icon: string;
  owned: boolean;
  unlocked: boolean;
  name?: string;
  level?: number;
}

export interface WalletBalance {
  address: string;
  relicBaseUnits: bigint | null;
}

/** Character roster, with the free/gated split and the wallet's real balance. */
export function renderCharacters(
  wallet: string,
  rows: readonly CharacterRow[],
  balance?: WalletBalance,
): string {
  const out = [`<b>🎭 Jobs — ${esc(wallet)}</b>`, ''];

  if (balance) {
    const held =
      balance.relicBaseUnits === null
        ? '<i>unreadable</i>'
        : `<b>${esc(formatRelic(balance.relicBaseUnits))} RELIC</b>`;
    out.push(`${code(shortAddr(balance.address))} · holding ${held}`, '');
  }

  const locked = rows.filter((r) => !r.owned && !r.unlocked).length;

  for (const r of rows) {
    const state = r.owned
      ? `✅ owned — <b>${esc(r.name ?? 'unnamed')}</b>${r.level ? ` lv${r.level}` : ''}`
      : r.unlocked
        ? '🆓 free — tap to create'
        : '🔒 locked';
    out.push(`${r.icon} <b>${esc(r.classId)}</b> · ${state}`);
  }

  out.push('', '───────────────');

  if (locked > 0) {
    out.push(
      `🔒 <b>${locked} job${locked === 1 ? '' : 's'} locked.</b> These need RELIC held on`,
      'this wallet — the game rejects them with <code>token_required</code>.',
      '',
    );
  }
  out.push(
    '<i>The exact threshold is enforced server-side and is not published,</i>',
    '<i>so this shows what the server actually reported for this wallet</i>',
    '<i>rather than a hardcoded number.</i>',
  );
  return out.join('\n');
}

export const HELP = [
  '<b>🎮 relic-bot</b>',
  '',
  'Automation fleet for <b>playrelic.gg</b> with an optional LLM brain.',
  '',
  '<b>What it can and cannot do</b>',
  '• Gameplay and selling never sign a transaction.',
  '• The treasury can move funds, but <b>only between your own wallets</b>.',
  '• No code exists that can send to an outside address.',
  '',
  'Use the buttons below, or these commands:',
  '',
  '<code>/status</code> — fleet overview',
  '<code>/characters</code> — roster, and create new heroes',
  '<code>/wallets</code> — list, create, import, export',
  '<code>/holdings</code> — SOL and token balances',
  '<code>/sweep</code> — collect tokens into the main wallet',
  '<code>/fund</code> — top up wallets low on gas',
  '<code>/gate</code> — token-gate state per wallet',
  '<code>/otak</code> — the LLM brain',
  '<code>/parks</code> — what is blocked, and why',
  '',
  '<i>Tip: a wallet needs a character before it can enter the world.</i>',
].join('\n');
