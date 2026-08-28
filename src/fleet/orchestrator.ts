/**
 * Fleet orchestrator: runs N accounts concurrently.
 *
 * Multi-account notes:
 *  - The game enforces one live session per account (`device_busy`), so each
 *    account gets its own keypair and its own stable deviceId.
 *  - Starts are staggered and every action is jittered, so the fleet does not
 *    move on one synchronised beat.
 *  - A fleet-scoped refusal (e.g. `client_outdated`) parks every account, not
 *    just the one that hit it. See ParkRegistry.blocking().
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { Connection } from '@solana/web3.js';
import type { Config } from '../config.js';
import { loadFleet, type Account } from '../wallet/keystore.js';
import { RestClient } from '../net/rest.js';
import { AuthClient } from '../auth/client.js';
import { ParkRegistry } from '../safety/park.js';
import { Ledger, CombatMemory } from '../safety/ledger.js';
import { Watchdog, type SilenceReport } from '../safety/watchdog.js';
import { Otak } from '../otak/index.js';
import { GateChecker } from '../economy/gate.js';
import { Marketplace } from '../economy/marketplace.js';
import { AccountRunner, type AccountStatus } from './account.js';
import { Notifier, detectSuspicious, type EventKind } from '../safety/notify.js';
import { logger } from '../log.js';

const log = logger('fleet');

export interface FleetAlert {
  kind: EventKind;
  text: string;
  accountId?: string;
  /** Overrides the default kind+account dedupe key. */
  dedupeKey?: string;
  /** Pre-rendered for chat, so a sink cannot accidentally drop the wallet. */
  formatted: string;
}

export type AlertSink = (alert: FleetAlert) => void | Promise<void>;

export class Fleet {
  readonly parks = new ParkRegistry();
  readonly ledger: Ledger;
  readonly combat: CombatMemory;
  readonly otak: Otak;

  private runners: AccountRunner[] = [];
  private rescanTimer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  /** Grades events so only what matters reaches Telegram. */
  private readonly notifier = new Notifier();
  private authFailures = 0;
  private watchdog: Watchdog;
  private alertSinks: AlertSink[] = [];
  private running = false;

  constructor(
    private readonly cfg: Config,
    rpcUrl?: string,
  ) {
    this.ledger = new Ledger(cfg.RELIC_DATA_DIR);
    this.combat = new CombatMemory(cfg.RELIC_DATA_DIR);
    this.otak = new Otak({
      enabled: cfg.OTAK_ENABLED,
      timeoutMs: cfg.OTAK_TIMEOUT_MS,
      maxCallsPerHour: cfg.OTAK_MAX_CALLS_PER_HOUR,
    });

    const rest = new RestClient(cfg.RELIC_BASE_URL);
    const connection = rpcUrl ? new Connection(rpcUrl, 'confirmed') : null;

    this.deps = {
      cfg,
      alert: (kind, text, accountId) => void this.alert({ kind, text, accountId }),
      auth: new AuthClient(rest),
      parks: this.parks,
      ledger: this.ledger,
      combat: this.combat,
      otak: this.otak,
      gate: new GateChecker(rest, connection),
      market: new Marketplace(rest),
    };

    this.watchdog = new Watchdog(
      this.ledger,
      this.combat,
      cfg.WATCHDOG_SILENCE_MIN * 60_000,
      (reports) => this.onSilence(reports),
    );

    this.parks.onPark((entry) => {
      if (!entry.needsOperator) return;
      const kind: EventKind =
        entry.key === 'banned' ? 'ban' : entry.scope === 'fleet' ? 'fleet_park' : 'account_park';
      void this.alert({
        kind,
        text: `${entry.key}: ${entry.reason}`,
        ...(entry.accountId ? { accountId: entry.accountId } : {}),
      });
    });
  }

  private readonly deps: ConstructorParameters<typeof AccountRunner>[1];

  onAlert(sink: AlertSink): void {
    this.alertSinks.push(sink);
  }

  private async alert(a: Omit<FleetAlert, 'formatted'> & { formatted?: string }): Promise<void> {
    // Grade before sending: a channel full of routine noise stops being read,
    // and then a real alert goes unnoticed too.
    const event = {
      kind: a.kind,
      text: a.text,
      ...(a.accountId ? { accountId: a.accountId } : {}),
      ...(a.dedupeKey ? { dedupeKey: a.dedupeKey } : {}),
    };
    if (!this.notifier.shouldSend(event)) {
      log.debug(`suppressed ${a.kind}: ${a.text.slice(0, 80)}`);
      return;
    }
    a.formatted = this.notifier.format(event);
    for (const s of this.alertSinks) {
      try {
        await s(a as FleetAlert);
      } catch (e) {
        log.warn(`alert sink failed: ${(e as Error).message}`);
      }
    }
  }

  private onSilence(reports: SilenceReport[]): void {
    const lines = reports.map(
      (r) =>
        `  ${r.accountId}: nothing for ${Math.round(r.silentForMs / 60_000)}m ` +
        `(battles=${r.battles})`,
    );
    void this.alert({
      kind: 'silence',
      // Key on how many wallets are affected, not just the kind. Without this
      // a spreading outage is reported once at its smallest: five wallets go
      // quiet and alert, twelve more go quiet two minutes later and are
      // silently deduplicated away for ten minutes.
      dedupeKey: `silence:${reports.length}`,
      text:
        `${reports.length} of ${this.runners.length} wallets producing NOTHING ` +
        `despite zero errors:\n` +
        lines.join('\n'),
    });

    // Everything connected but nothing produced across the whole fleet is the
    // signature of a protocol change, not of bad luck.
    const suspicion = detectSuspicious({
      refusalRate: 0,
      authFailures: this.authFailures,
      silentAccounts: reports.length,
      totalAccounts: this.runners.length,
    });
    if (suspicion) {
      void this.alert({ kind: 'suspicious', text: suspicion });
    }
  }

  accounts(): Account[] {
    return this.runners.map((r) => r.account);
  }

  status(): AccountStatus[] {
    return this.runners.map((r) => r.status());
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const accounts = loadFleet(this.cfg.RELIC_KEYS_DIR);
    log.info(`loaded ${accounts.length} account(s) from ${this.cfg.RELIC_KEYS_DIR}`);

    const max = Math.max(1, Math.floor(this.cfg.FLEET_MAX_CONCURRENT));
    const active = accounts.slice(0, max);
    if (accounts.length > max) {
      log.warn(
        `FLEET_MAX_CONCURRENT=${max} — running ${max} of ${accounts.length} accounts`,
      );
    }

    this.runners = active.map((a) => new AccountRunner(a, this.deps));

    if (this.otak.enabled) {
      await this.otak.checkHealth();
    }

    this.watchdog.start(() => this.runners.map((r) => r.account.id));

    // Close the loop on silence alerts: an operator told a wallet went quiet
    // should also be told when it came back, or the last alarm stands forever.
    this.recoveryTimer = setInterval(() => {
      const back = this.watchdog.drainRecovered();
      if (back.length === 0) return;
      void this.alert({
        kind: 'character_created',
        dedupeKey: `recovered:${back.join(',')}`,
        text: `producing again: ${back.join(', ')}`,
      });
    }, 60_000);
    this.recoveryTimer.unref?.();

    // Stagger starts so N sessions do not authenticate in the same second.
    for (const [i, runner] of this.runners.entries()) {
      this.launch(runner, i * this.cfg.FLEET_START_STAGGER_MS);
    }

    // A wallet minted from Telegram used to sit unused until the process was
    // restarted, because the key directory was read exactly once. Rescan
    // periodically so a new wallet joins on its own.
    this.rescanTimer = setInterval(() => void this.rescan(), 60_000);
    this.rescanTimer.unref?.();

    log.info(`fleet started (${this.runners.length} accounts)`);
  }

  private launch(runner: AccountRunner, delayMs: number): void {
    void (async () => {
      if (delayMs > 0) await sleep(delayMs);
      if (!this.running) return;
      await runner.run();
    })();
  }

  /**
   * Pick up wallets added since start.
   *
   * Only genuinely new keys are launched, and the concurrency ceiling still
   * applies — a directory full of keys must not silently become a hundred
   * simultaneous logins.
   */
  private async rescan(): Promise<void> {
    if (!this.running) return;

    let onDisk: Account[];
    try {
      onDisk = loadFleet(this.cfg.RELIC_KEYS_DIR);
    } catch (err) {
      log.debug(`rescan skipped: ${(err as Error).message}`);
      return;
    }

    const known = new Set(this.runners.map((r) => r.account.id));
    const max = Math.max(1, Math.floor(this.cfg.FLEET_MAX_CONCURRENT));
    const room = max - this.runners.length;
    if (room <= 0) return;

    const fresh = onDisk.filter((a) => !known.has(a.id)).slice(0, room);
    if (fresh.length === 0) return;

    log.info(`rescan found ${fresh.length} new wallet(s) — starting them`);
    for (const [i, account] of fresh.entries()) {
      const runner = new AccountRunner(account, this.deps);
      this.runners.push(runner);
      // Stagger newcomers too; a batch minted at once would otherwise all
      // authenticate in the same second.
      this.launch(runner, i * this.cfg.FLEET_START_STAGGER_MS);
    }

    void this.alert({
      kind: 'character_created',
      text: `${fresh.length} new wallet(s) joined the fleet: ${fresh.map((a) => a.id).join(', ')}`,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    this.watchdog.stop();
    await Promise.allSettled(this.runners.map((r) => r.stop()));
    log.info('fleet stopped');
  }
}
