import { describe, it, expect } from 'vitest';
import {
  esc,
  fit,
  callbackFits,
  shortAddr,
  relTime,
  renderStatus,
  renderWallets,
  renderHoldings,
  renderGate,
  renderParks,
  renderCharacters,
  renderMinted,
  renderOnboard,
  TG_MAX_MESSAGE,
  TG_MAX_CALLBACK,
} from '../src/telegram/ui.js';
import type { AccountStatus } from '../src/fleet/account.js';

const ADDR = '2wqQaWMbzY5b8JHcEoF9EHf7CKTxSckEiSRLw1Szrfmd';

function acct(over: Partial<AccountStatus> = {}): AccountStatus {
  return {
    id: 'wallet-01',
    address: ADDR,
    phase: 'playing',
    gate: { allowed: false, relicBaseUnits: 0n, checkedAt: Date.now() },
    lastValueAt: Date.now() - 60_000,
    battles: 3,
    listings: 1,
    note: 'attacking troll',
    vitals: {
      hp: 72,
      maxHp: 120,
      mana: 40,
      maxMana: 80,
      level: 4,
      gold: 250,
      depth: 2,
    },
    ...over,
  };
}

describe('HTML escaping — server and user text can contain anything', () => {
  it('escapes every character Telegram treats specially', () => {
    expect(esc(`<b>&"'`)).toBe('&lt;b&gt;&amp;&quot;&#39;');
  });

  it('escapes hostile text inside a rendered view', () => {
    const out = renderStatus([acct({ note: '<script>alert(1)</script>' })]);
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('escapes a hostile wallet id', () => {
    const out = renderWallets([{ id: '<img src=x>', address: ADDR, isMain: false }]);
    expect(out).not.toContain('<img');
  });

  it('handles null and undefined without printing them raw', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
});

describe('Telegram hard limits', () => {
  it('keeps a large fleet under the 4096-character message cap', () => {
    const rows = Array.from({ length: 60 }, (_, i) => acct({ id: `wallet-${i}` }));
    const out = fit(renderStatus(rows));
    expect(out.length).toBeLessThanOrEqual(TG_MAX_MESSAGE);
    expect(out).toContain('truncated');
  });

  it('leaves a short message untouched', () => {
    const out = renderStatus([acct()]);
    expect(fit(out)).toBe(out);
  });

  it('cuts at a line boundary rather than mid-tag', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const out = fit(text);
    expect(out.length).toBeLessThanOrEqual(TG_MAX_MESSAGE);
    expect(out).not.toMatch(/<[a-z]*$/);
  });

  it('accepts realistic callback data and rejects oversized', () => {
    expect(callbackFits('chr:new:wallet-01:necromancer')).toBe(true);
    expect(callbackFits(`wal:exp:${'x'.repeat(TG_MAX_CALLBACK)}`)).toBe(false);
  });
});

describe('views render without throwing on empty or partial data', () => {
  it('handles an empty fleet', () => {
    expect(renderStatus([])).toContain('No accounts');
    expect(renderWallets([])).toContain('none yet');
    expect(renderGate([])).toContain('No accounts');
    expect(renderParks([])).toContain('Nothing is parked');
  });

  it('handles an unchecked gate and unreadable balance', () => {
    const out = renderGate([{ id: 'w1', address: ADDR, allowed: null, relicBaseUnits: null }]);
    expect(out).toContain('unchecked');
    expect(out).toContain('unknown');
  });

  it('handles a wallet with no tokens', () => {
    const out = renderHoldings([
      { id: 'w1', address: ADDR, isMain: true, sol: 0n, tokens: [] },
    ]);
    expect(out).toContain('no tokens');
  });

  it('renders characters with and without a balance block', () => {
    const rows = [
      { classId: 'knight', icon: '🛡️', owned: true, unlocked: true, name: 'Roland', level: 3 },
      { classId: 'mage', icon: '🔮', owned: false, unlocked: false },
    ];
    expect(renderCharacters('wallet-01', rows)).toContain('Roland');
    const withBal = renderCharacters('wallet-01', rows, {
      address: ADDR,
      relicBaseUnits: 12_500_000n,
    });
    expect(withBal).toContain('12.5 RELIC');
    expect(withBal).toContain('locked');
  });

  it('renders a mint result with the backup warning', () => {
    const out = renderMinted([{ id: 'wallet-09', address: ADDR }]);
    expect(out).toContain('wallet-09');
    expect(out.toLowerCase()).toContain('back them up');
  });

  it('summarises onboarding successes and failures separately', () => {
    const out = renderOnboard([
      { walletId: 'w1', ok: true, classId: 'knight', name: 'Roland' },
      { walletId: 'w2', ok: false, reason: 'class requires RELIC held on this wallet' },
    ]);
    expect(out).toContain('1/2');
    expect(out).toContain('Roland');
    expect(out).toContain('RELIC');
  });
});

describe('vitals meters', () => {
  it('shows HP and Mana bars with percentages', () => {
    const out = renderStatus([acct()]);
    expect(out).toContain('❤️');
    expect(out).toContain('🔷');
    expect(out).toContain('60%'); // 72/120
    expect(out).toContain('50%'); // 40/80
    expect(out).toContain('lv4');
  });

  it('renders nothing rather than failing when a wallet has no vitals', () => {
    const rows = [{ ...acct(), vitals: undefined } as unknown as AccountStatus];
    expect(() => renderStatus(rows)).not.toThrow();
  });

  it('handles unknown pools without printing NaN', () => {
    const out = renderStatus([
      acct({
        vitals: { hp: null, maxHp: null, mana: null, maxMana: null, level: null, gold: null, depth: null },
      }),
    ]);
    expect(out).not.toMatch(/NaN|undefined/);
  });
});

describe('formatting helpers', () => {
  it('shortens an address without losing its ends', () => {
    const s = shortAddr(ADDR);
    expect(s.startsWith(ADDR.slice(0, 4))).toBe(true);
    expect(s.endsWith(ADDR.slice(-4))).toBe(true);
    expect(s.length).toBeLessThan(ADDR.length);
  });

  it('leaves a short address alone', () => {
    expect(shortAddr('abc')).toBe('abc');
  });

  it('describes elapsed time in human units', () => {
    const now = Date.now();
    expect(relTime(0)).toBe('never');
    expect(relTime(now - 30_000, now)).toMatch(/s ago/);
    expect(relTime(now - 5 * 60_000, now)).toMatch(/m ago/);
    expect(relTime(now - 5 * 3_600_000, now)).toMatch(/h ago/);
    expect(relTime(now - 5 * 86_400_000, now)).toMatch(/d ago/);
  });

  it('never reports negative time for a clock skew', () => {
    expect(relTime(Date.now() + 60_000)).toMatch(/0s ago|s ago/);
  });
});
