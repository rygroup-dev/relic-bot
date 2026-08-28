/**
 * relic-bot entrypoint.
 *
 * Boots the fleet, the watchdog, and (if configured) the Telegram control bot,
 * then waits for a signal. Everything value-producing runs inside the fleet.
 */

import { loadConfig } from './config.js';
import { setLogLevel, logger } from './log.js';
import { Fleet } from './fleet/orchestrator.js';
import { ControlBot } from './telegram/bot.js';

const log = logger('main');

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.LOG_LEVEL);

  log.info('relic-bot starting');
  log.info(`base=${cfg.RELIC_BASE_URL} keys=${cfg.RELIC_KEYS_DIR} otak=${cfg.OTAK_ENABLED ? 'on' : 'off'}`);
  log.info('payments are hard-locked: this process can sell, and cannot buy');

  const fleet = new Fleet(cfg, process.env.SOLANA_RPC_URL);

  let control: ControlBot | null = null;
  // Only the token is required: with no owner id configured, the first person
  // to message the bot claims it (see ControlBot.claimIfUnowned).
  if (cfg.TELEGRAM_BOT_TOKEN) {
    control = new ControlBot(
      { token: cfg.TELEGRAM_BOT_TOKEN, ownerIds: cfg.ownerIds, cfg },
      fleet,
    );
    await control.start();
    if (cfg.ownerIds.length === 0) {
      log.warn('no TELEGRAM_OWNER_IDS set — the first chat to message the bot will claim it');
    }
  } else {
    log.warn('telegram disabled (TELEGRAM_BOT_TOKEN unset)');
  }

  await fleet.start();

  let stopping = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig} received, shutting down`);
    await fleet.stop();
    await control?.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Keep the process alive; all work happens in the fleet's own tasks.
  await new Promise<never>(() => {});
}

main().catch((err) => {
  log.error(`fatal: ${(err as Error).message}`);
  log.error((err as Error).stack ?? '');
  process.exit(1);
});
