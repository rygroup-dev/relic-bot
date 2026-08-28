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

/** The fleet overview. */
export function renderStatus(rows: readonly AccountStatus[], now = Date.now()): string {
  if (rows.length === 0) {
    return '<b>Fleet</b>\n\nNo accounts are running.\n\nAdd a wallet with <b>Wallets → New</b>.';
  }

  const playing = rows.filter((r) => r.phase === 'playing').length;
  const parked = rows.filter((r) => r.phase === 'parked').length;
  const banned = rows.filter((r) => r.phase === 'banned').length;
  const battles = rows.reduce((s, r) => s + r.battles, 0);
  const listed = rows.reduce((s, r) => s + r.listings, 0);

  const out: string[] = [
    '<b>⚔️ Fleet status</b>',
    '',
    `${rows.length} wallet${rows.length === 1 ? '' : 's'} · ` +
      `🟢 ${playing} playing · 🟡 ${parked} parked${banned ? ` · 🔴 ${banned} banned` : ''}`,
    `${battles} battle${battles === 1 ? '' : 's'} · ${listed} listing${listed === 1 ? '' : 's'} created`,
    '',
    '───────────────',
  ];

  for (const r of rows) {
    const gate =
      r.gate === null ? '· gate ?' : r.gate.allowed ? '· gate 🔓 open' : '· gate 🔒 closed';
    out.push(
      '',
      `${phaseIcon(r.phase)} <b>${esc(r.id)}</b>  <i>${esc(r.phase)}</i> ${gate}`,
      `   ${code(shortAddr(r.address))}`,
      `   battles <b>${r.battles}</b> · listed <b>${r.listings}</b> · value ${esc(relTime(r.lastValueAt, now))}`,
    );
    if (r.note) out.push(`   <i>${esc(r.note.slice(0, 120))}</i>`);
  }

  out.push(
    '',
    '───────────────',
    '<i>Liveness is measured by produced value, not by absence of errors.</i>',
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
  const out = ['<b>💰 Holdings</b>', ''];
  for (const r of rows) {
    out.push(
      `${r.isMain ? '⭐' : '•'} <b>${esc(r.id)}</b>${r.isMain ? ' <i>(main)</i>' : ''}`,
      `   ${code(shortAddr(r.address))}`,
      `   ◎ ${esc(fmtSol(r.sol))} SOL`,
    );
    if (r.tokens.length === 0) {
      out.push('   <i>no token balances</i>');
    } else {
      for (const t of r.tokens) {
        out.push(
          `   ${esc(fmtAmount(t.amount, t.decimals))} ${esc(t.label ?? shortAddr(t.mint))}`,
        );
      }
    }
    out.push('');
  }
  out.push('<i>Sweeps move everything into the main wallet ⭐.</i>');
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

export function renderWallets(
  rows: readonly { id: string; address: string; isMain: boolean }[],
): string {
  if (rows.length === 0) {
    return '<b>👛 Wallets</b>\n\nNone yet. Use <b>New</b> or <b>Import</b> below.';
  }
  const out = ['<b>👛 Wallets</b>', ''];
  for (const r of rows) {
    out.push(`${r.isMain ? '⭐' : '•'} <b>${esc(r.id)}</b>${r.isMain ? ' <i>(main)</i>' : ''}`);
    out.push(`   ${code(r.address)}`);
  }
  out.push('', '<i>⭐ is the main account — sweeps collect here.</i>');
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
  '<code>/wallets</code> — list, create, import, export',
  '<code>/holdings</code> — SOL and token balances',
  '<code>/sweep</code> — collect tokens into the main wallet',
  '<code>/fund</code> — top up wallets low on gas',
  '<code>/gate</code> — token-gate state per wallet',
  '<code>/otak</code> — the LLM brain',
  '<code>/parks</code> — what is blocked, and why',
].join('\n');
