/**
 * relicctl — operational commands that do not require the fleet to be running.
 *
 * Every command here is read-only with respect to money. There is no "buy"
 * subcommand because there is no code that could implement one.
 */

import { Connection } from '@solana/web3.js';
import { loadConfig } from './config.js';
import { setLogLevel } from './log.js';
import { loadFleet } from './wallet/keystore.js';
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

function usage(): void {
  console.log(
    [
      'relicctl <command>',
      '',
      '  wallets          list configured accounts and their addresses',
      '  balance          on-chain RELIC balance per wallet (Token-2022)',
      '  login            authenticate every wallet and report characters',
      '  gate             query the server token gate per wallet',
      '  listings         show current marketplace listings',
      '  ledger           summarise produced value per wallet',
      '  doctor           check config, key permissions, and connectivity',
      '',
      'There is deliberately no "buy" command: relic-bot cannot sign transactions.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const cmd = process.argv[2];

  switch (cmd) {
    case 'wallets': {
      for (const a of loadFleet(cfg.RELIC_KEYS_DIR)) {
        console.log(`${a.id.padEnd(16)} ${a.address}  device=${a.deviceId.slice(0, 8)}…`);
      }
      break;
    }

    case 'balance': {
      const conn = new Connection(rpc, 'confirmed');
      console.log(`mint ${RELIC_MINT}\nprogram ${TOKEN_2022_PROGRAM_ID} (SPL Token-2022)\n`);
      for (const a of loadFleet(cfg.RELIC_KEYS_DIR)) {
        const bal = await readRelicBalance(conn, a.address);
        console.log(
          `${a.id.padEnd(16)} ${bal === null ? 'unreadable' : `${formatRelic(bal)} RELIC`}`,
        );
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
      const conn = new Connection(rpc, 'confirmed');
      const gate = new GateChecker(rest, conn);
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
        '\nThe gate threshold is enforced server-side and is not published in the\n' +
          'client bundle or the docs. The above is what the server actually answered.',
      );
      break;
    }

    case 'listings': {
      const [a] = loadFleet(cfg.RELIC_KEYS_DIR);
      if (!a) throw new Error('no accounts configured');
      const s = await auth.login(a);
      const market = new Marketplace(rest);
      const rows = await market.listings(s.token, { limit: 25 });
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

    case 'doctor': {
      let ok = true;
      try {
        const accts = loadFleet(cfg.RELIC_KEYS_DIR);
        console.log(`keys      OK    ${accts.length} account(s), permissions fine`);
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
        const conn = new Connection(rpc, 'confirmed');
        await conn.getSlot();
        console.log(`solana    OK    ${rpc}`);
      } catch (err) {
        console.log(`solana    WARN  ${(err as Error).message}`);
      }
      console.log(
        `telegram  ${cfg.TELEGRAM_BOT_TOKEN && cfg.ownerIds.length ? 'OK    configured' : 'WARN  not configured'}`,
      );
      console.log(`otak      ${cfg.OTAK_ENABLED ? 'ON' : 'OFF'}   heuristics always available`);
      console.log('payments  LOCKED no transaction-signing code exists');
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
