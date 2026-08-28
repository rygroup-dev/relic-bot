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
import { logger } from '../log.js';

const log = logger('fleet');

export interface FleetAlert {
  kind: 'silence' | 'park' | 'ban';
  text: string;
}

export type AlertSink = (alert: FleetAlert) => void | Promise<void>;

export class Fleet {
  readonly parks = new ParkRegistry();
  readonly ledger: Ledger;
  readonly combat: CombatMemory;
  readonly otak: Otak;

  private runners: AccountRunner[] = [];
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
      void this.alert({
        kind: entry.key === 'banned' ? 'ban' : 'park',
        text:
          `PARK ${entry.scope}${entry.accountId ? `/${entry.accountId}` : ''} ` +
          `"${entry.key}": ${entry.reason}`,
      });
    });
  }

  private readonly deps: ConstructorParameters<typeof AccountRunner>[1];

  onAlert(sink: AlertSink): void {
    this.alertSinks.push(sink);
  }

  private async alert(a: FleetAlert): Promise<void> {
    for (const s of this.alertSinks) {
      try {
        await s(a);
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
      text:
        `${reports.length} account(s) producing NOTHING despite zero errors:\n` +
        lines.join('\n'),
    });
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

    // Stagger starts so N sessions do not authenticate in the same second.
    for (const [i, runner] of this.runners.entries()) {
      const delay = i * this.cfg.FLEET_START_STAGGER_MS;
      void (async () => {
        if (delay > 0) await sleep(delay);
        if (!this.running) return;
        await runner.run();
      })();
    }

    log.info(`fleet started (${this.runners.length} accounts)`);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.watchdog.stop();
    await Promise.allSettled(this.runners.map((r) => r.stop()));
    log.info('fleet stopped');
  }
}
