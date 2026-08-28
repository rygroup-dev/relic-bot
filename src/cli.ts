/**
 * relicctl — operational commands.
 *
 * Game commands are read-only with respect to money. Treasury commands can
 * move funds, but only between wallets you control: see src/wallet/treasury.ts
 * for the guard. Every treasury command defaults to a dry run.
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { setLogLevel } from './log.js';
import { loadFleet } from './wallet/keystore.js';
import {
  createWallet,
  importWallet,
  exportWalletJson,
  fleetMembers,
  resolveMain,
  persistMainAccount,
} from './wallet/manage.js';
import { Treasury, fmtSol, fmtAmount, type SweepReport } from './wallet/treasury.js';
import { RestClient } from './net/rest.js';
import { AuthClient } from './auth/client.js';
import { GateChecker, formatRelic, readRelicBalance } from './economy/gate.js';
import { Marketplace } from './economy/marketplace.js';
import { Ledger, CombatMemory } from './safety/ledger.js';
import { RELIC_MINT, TOKEN_2022_PROGRAM_ID } from './protocol/endpoints.js';

const cfg = loadConfig();
setLogLevel(cfg.LOG_LEVEL);

const rest = new RestClient(cfg.RELIC_BASE_URL);
const auth = new AuthClient(rest);
const rpc = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);

function connection(): Connection {
  return new Connection(rpc, 'confirmed');
}

function treasury(): Treasury {
  const members = fleetMembers(cfg.RELIC_KEYS_DIR);
  const main = resolveMain(members, cfg.RELIC_MAIN_ACCOUNT);
  return new Treasury({
    connection: connection(),
    fleet: members,
    mainAddress: main.address,
    maxFundLamports: BigInt(Math.round(cfg.GAS_MAX_SOL * LAMPORTS_PER_SOL)),
  });
}

function printReport(r: SweepReport, dry: boolean): void {
  if (r.transfers.length === 0 && r.errors.length === 0) {
    console.log('nothing to do');
  }
  for (const t of r.transfers) {
    const label = t.mint === 'SOL' ? 'SOL' : `${t.mint.slice(0, 8)}…`;
    console.log(
      `  ${dry ? '[dry]' : '  ok '} ${t.wallet.padEnd(14)} ${fmtAmount(t.amount, t.decimals).padStart(18)} ${label}` +
        (t.signature ? `  ${t.signature.slice(0, 16)}…` : ''),
    );
  }
  for (const s of r.skipped) console.log(`  skip  ${s.wallet.padEnd(14)} ${s.reason}`);
  for (const e of r.errors) console.log(`  FAIL  ${e.wallet.padEnd(14)} ${e.error}`);
  if (dry) console.log('\ndry run — nothing was broadcast. Re-run with --execute to send.');
}

function usage(): void {
  console.log(
    [
      'relicctl <command>',
      '',
      'game',
      '  doctor                 check config, key permissions, connectivity',
      '  wallets                list accounts and addresses',
      '  login                  authenticate every wallet',
      '  gate                   query the server token gate per wallet',
      '  listings               show current marketplace listings',
      '  ledger                 summarise produced value per wallet',
      '',
      'wallet management',
      '  new [id]               generate a new wallet',
      '  import <key> [id]      import a base58 or JSON secret key',
      '  export <id>            print a wallet as solana-keygen JSON  (SECRET)',
      '  main [id]              show or set the main account',
      '',
      'treasury  (dry run by default; add --execute to broadcast)',
      '  balance                on-chain RELIC per wallet',
      '  holdings               every token balance per wallet',
      '  sweep [--execute] [--with-sol]   move all tokens into the main account',
      '  fund  [--execute]      top up wallets that are low on SOL for gas',
      '',
      'Funds can only move between wallets you control. There is no command,',
      'and no code, that can send to an address outside your own fleet.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const cmd = argv[0];

  switch (cmd) {
    // ---------------------------------------------------------------- game --
    case 'wallets': {
      const members = fleetMembers(cfg.RELIC_KEYS_DIR);
      const mainAcct = resolveMain(members, cfg.RELIC_MAIN_ACCOUNT);
      for (const a of loadFleet(cfg.RELIC_KEYS_DIR)) {
        const star = a.address === mainAcct.address ? ' *MAIN' : '';
        console.log(`${a.id.padEnd(16)} ${a.address}  device=${a.deviceId.slice(0, 8)}…${star}`);
      }
      break;
    }

    case 'login': {
      for (const a of loadFleet(cfg.RELIC_KEYS_DIR)) {
        try {
          const s = await auth.login(a);
          console.log(
            `${a.id.padEnd(16)} ok  characters=${s.characters.length} ` +
              `active=${s.character?.name ?? '(none)'}`,
          );
        } catch (err) {
          console.log(`${a.id.padEnd(16)} FAILED  ${(err as Error).message}`);
        }
      }
      break;
    }

    case 'gate': {
      const gate = new GateChecker(rest, connection());
      for (const a of loadFleet(cfg.RELIC_KEYS_DIR)) {
        try {
          const s = await auth.login(a);
          const g = await gate.check(a.id, s.token, a.address);
          console.log(
            `${a.id.padEnd(16)} gate=${g.allowed ? 'OPEN' : 'CLOSED'}  ` +
              `relic=${g.relicBaseUnits === null ? '?' : formatRelic(g.relicBaseUnits)}`,
          );
        } catch (err) {
          console.log(`${a.id.padEnd(16)} FAILED  ${(err as Error).message}`);
        }
      }
      console.log(
        '\nPlaying works while the gate is closed; market features do not.\n' +
          'The threshold is enforced server-side and is not published, so this\n' +
          'reports what the server actually answered rather than a guess.',
      );
      break;
    }

    case 'listings': {
      const [a] = loadFleet(cfg.RELIC_KEYS_DIR);
      if (!a) throw new Error('no accounts configured');
      const s = await auth.login(a);
      const rows = await new Marketplace(rest).listings(s.token, { limit: 25 });
      if (rows.length === 0) {
        console.log('no listings returned');
        break;
      }
      for (const l of rows) {
        console.log(
          `${String(l.name ?? l.itemId ?? l.id).padEnd(30)} ` +
            `${String(l.priceMicroUsdc ?? '?').padStart(12)} micro ${l.currency ?? 'usdc'} ` +
            `${l.rarity ?? ''}`,
        );
      }
      break;
    }

    case 'ledger': {
      const ledger = new Ledger(cfg.RELIC_DATA_DIR);
      const combat = new CombatMemory(cfg.RELIC_DATA_DIR);
      const ids = ledger.accounts();
      if (ids.length === 0) {
        console.log('ledger is empty — nothing has been produced yet');
        break;
      }
      for (const id of ids) {
        const last = ledger.lastValueAt(id);
        console.log(
          `${id.padEnd(16)} battles=${String(combat.totalBattles(id)).padStart(5)}  ` +
            `lastValue=${last ? new Date(last).toISOString() : 'never'}`,
        );
      }
      break;
    }

    // ------------------------------------------------- wallet management --
    case 'new': {
      const w = createWallet(cfg.RELIC_KEYS_DIR, argv[1]);
      console.log(`created ${w.id}\n  address ${w.address}\n  file    ${w.path} (0600)`);
      console.log('\nBack up the key file. If you lose it, the wallet is gone.');
      break;
    }

    case 'import': {
      const secret = argv[1];
      if (!secret) throw new Error('usage: relicctl import <base58-or-json-key> [id]');
      const w = importWallet(cfg.RELIC_KEYS_DIR, secret, argv[2]);
      console.log(`imported ${w.id}\n  address ${w.address}\n  file    ${w.path} (0600)`);
      break;
    }

    case 'export': {
      const id = argv[1];
      if (!id) throw new Error('usage: relicctl export <wallet-id>');
      const e = exportWalletJson(cfg.RELIC_KEYS_DIR, id);
      console.error(`# ${e.id}  ${e.address}`);
      console.error('# SECRET KEY BELOW — anyone with this controls the wallet.');
      console.log(e.json);
      break;
    }

    case 'main': {
      const members = fleetMembers(cfg.RELIC_KEYS_DIR);
      const want = argv[1];
      if (!want) {
        const m = resolveMain(members, cfg.RELIC_MAIN_ACCOUNT);
        console.log(`main account: ${m.id}  ${m.address}`);
        console.log(`\nall wallets: ${members.map((x) => x.id).join(', ')}`);
        console.log('set with: relicctl main <wallet-id>');
        break;
      }
      const chosen = resolveMain(members, want);
      persistMainAccount(join(process.cwd(), '.env'), chosen.id);
      console.log(`main account set to ${chosen.id}  ${chosen.address}`);
      console.log('written to .env — restart the bot for it to take effect');
      break;
    }

    // --------------------------------------------------------- treasury --
    case 'balance': {
      const conn = connection();
      console.log(`mint ${RELIC_MINT}\nprogram ${TOKEN_2022_PROGRAM_ID} (SPL Token-2022)\n`);
      for (const a of loadFleet(cfg.RELIC_KEYS_DIR)) {
        const bal = await readRelicBalance(conn, a.address);
        console.log(
          `${a.id.padEnd(16)} ${bal === null ? 'unreadable' : `${formatRelic(bal)} RELIC`}`,
        );
      }
      break;
    }

    case 'holdings': {
      const t = treasury();
      console.log(`main account: ${t.main.id}  ${t.main.address}\n`);
      for (const m of fleetMembers(cfg.RELIC_KEYS_DIR)) {
        const sol = await t.solBalance(m.address);
        const toks = await t.tokenHoldings(m.address);
        const star = m.address === t.main.address ? ' *MAIN' : '';
        console.log(`${m.id}${star}  ${fmtSol(sol)} SOL`);
        if (toks.length === 0) console.log('    (no token balances)');
        for (const h of toks) {
          const known = h.mint === RELIC_MINT ? ' RELIC' : '';
          console.log(
            `    ${fmtAmount(h.amount, h.decimals).padStart(18)}  ${h.mint}${known}`,
          );
        }
      }
      break;
    }

    case 'sweep': {
      const execute = flag('execute');
      const t = treasury();
      console.log(
        `sweeping all tokens into ${t.main.id} (${t.main.address})` +
          `${flag('with-sol') ? ' including residual SOL' : ''}\n`,
      );
      const r = await t.sweepAll({ dryRun: !execute, includeSol: flag('with-sol') });
      printReport(r, !execute);
      break;
    }

    case 'fund': {
      const execute = flag('execute');
      const t = treasury();
      const min = BigInt(Math.round(cfg.GAS_MIN_SOL * LAMPORTS_PER_SOL));
      const top = BigInt(Math.round(cfg.GAS_TOPUP_SOL * LAMPORTS_PER_SOL));
      console.log(
        `topping up wallets below ${fmtSol(min)} SOL with ${fmtSol(top)} SOL each,\n` +
          `from ${t.main.id} (${t.main.address})\n`,
      );
      const r = await t.fundGas(min, top, { dryRun: !execute });
      printReport(r, !execute);
      break;
    }

    // ----------------------------------------------------------- doctor --
    case 'doctor': {
      let ok = true;
      try {
        const accts = loadFleet(cfg.RELIC_KEYS_DIR);
        console.log(`keys      OK    ${accts.length} account(s), permissions fine`);
        const members = fleetMembers(cfg.RELIC_KEYS_DIR);
        const m = resolveMain(members, cfg.RELIC_MAIN_ACCOUNT);
        console.log(`main      OK    ${m.id} (${m.address.slice(0, 12)}…)`);
      } catch (err) {
        ok = false;
        console.log(`keys      FAIL  ${(err as Error).message}`);
      }
      try {
        const now = await rest.get<{ now?: number }>('/api/auth/now');
        console.log(`api       OK    server clock ${now?.now ?? '?'}`);
      } catch (err) {
        ok = false;
        console.log(`api       FAIL  ${(err as Error).message}`);
      }
      try {
        await connection().getSlot();
        console.log(`solana    OK    ${rpc}`);
      } catch (err) {
        console.log(`solana    WARN  ${(err as Error).message}`);
      }
      console.log(
        `telegram  ${cfg.TELEGRAM_BOT_TOKEN && cfg.ownerIds.length ? 'OK    configured' : 'WARN  not configured'}`,
      );
      console.log(`otak      ${cfg.OTAK_ENABLED ? 'ON' : 'OFF'}   heuristics always available`);
      console.log('game      LOCKED gameplay and selling never sign a transaction');
      console.log('treasury  FENCED transfers restricted to your own wallets');
      process.exit(ok ? 0 : 1);
    }

    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
