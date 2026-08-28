/**
 * Colyseus zone connection.
 *
 * Uses the official colyseus.js client pinned to 0.16.22 — byte-identical to
 * the version the production game ships (`VERSION="0.16.22"` in the bundle).
 * That pin is deliberate: the schema v5 wire format is versioned, and a
 * hand-rolled or mismatched decoder is exactly the class of silent-corruption
 * bug this project must not have.
 */

import { Client, Room } from 'colyseus.js';
import { classifyRefusal, ROOM, type RoomName } from '../protocol/messages.js';
import { logger } from '../log.js';

const log = logger('zone');

/**
 * Client version handshake.
 *
 * The server rejects a join with `client_outdated` (close code 4216) unless the
 * room options carry the xp-curve version the deployed client was built with.
 * Recovered from the bundle: `xpCurveVersion: gS`, where `gS` resolves through
 * the modal chunk's `a1` export to the literal 5.
 *
 * Overridable via RELIC_XP_CURVE_VERSION so a server-side bump can be followed
 * without a rebuild - a fleet-wide park plus one env change, not a redeploy.
 */
export const DEFAULT_XP_CURVE_VERSION = 5;

export function xpCurveVersion(): number {
  const raw = process.env.RELIC_XP_CURVE_VERSION;
  if (!raw) return DEFAULT_XP_CURVE_VERSION;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_XP_CURVE_VERSION;
}

export interface ZoneOptions {
  /** wss://playrelic.gg in production. */
  endpoint: string;
  room?: RoomName;
  token: string;
  name?: string;
  classId?: string;
  level?: number;
  col?: number;
  row?: number;
  getUpReadyAt?: number;
  duelsDisabled?: boolean;
}

export type ServerMessageHandler = (type: string, payload: unknown) => void;
export type StateHandler = (state: unknown) => void;

export class ZoneConnection {
  private room: Room | null = null;
  private messageHandlers: ServerMessageHandler[] = [];
  private stateHandlers: StateHandler[] = [];
  private leaveHandlers: ((code: number) => void)[] = [];
  private closed = false;

  constructor(private readonly opts: ZoneOptions) {}

  get connected(): boolean {
    return this.room !== null && !this.closed;
  }

  get sessionId(): string | null {
    return this.room?.sessionId ?? null;
  }

  onMessage(fn: ServerMessageHandler): void {
    this.messageHandlers.push(fn);
  }

  onState(fn: StateHandler): void {
    this.stateHandlers.push(fn);
  }

  onLeave(fn: (code: number) => void): void {
    this.leaveHandlers.push(fn);
  }

  async connect(): Promise<void> {
    const client = new Client(this.opts.endpoint);
    // colyseus.js carries the auth token on the http layer for /auth calls.
    client.auth.token = this.opts.token;

    const roomName = this.opts.room ?? ROOM.TOWN;
    // Mirror the production client's join options exactly. Omitting
    // xpCurveVersion is what gets a join refused as `client_outdated`.
    const options: Record<string, unknown> = {
      token: this.opts.token,
      xpCurveVersion: xpCurveVersion(),
    };
    if (this.opts.name) options.name = this.opts.name;
    if (this.opts.classId) options.classId = this.opts.classId;
    if (this.opts.level !== undefined) options.level = this.opts.level;
    if (this.opts.col !== undefined) options.col = this.opts.col;
    if (this.opts.row !== undefined) options.row = this.opts.row;
    if (this.opts.getUpReadyAt !== undefined) options.getUpReadyAt = this.opts.getUpReadyAt;
    if (this.opts.duelsDisabled !== undefined) options.duelsDisabled = this.opts.duelsDisabled;

    try {
      this.room = await client.joinOrCreate(roomName, options);
    } catch (err) {
      // Preserve the server's refusal string so the caller can classify it —
      // "banned", "client_outdated" and "device_busy" all surface here.
      const verdict = classifyRefusal(err);
      log.warn(`join ${roomName} refused (${verdict.kind}): ${(err as Error).message}`);
      throw err;
    }

    this.closed = false;
    log.info(`joined ${roomName} as session ${this.room.sessionId}`);

    // Wildcard handler: the server's message vocabulary is not fully enumerated
    // client-side, so we observe everything rather than guess a subset.
    this.room.onMessage('*', (type, payload) => {
      for (const fn of this.messageHandlers) {
        try {
          fn(String(type), payload);
        } catch (e) {
          log.warn(`message handler threw for "${String(type)}": ${(e as Error).message}`);
        }
      }
    });

    this.room.onStateChange((state) => {
      for (const fn of this.stateHandlers) {
        try {
          fn(state);
        } catch (e) {
          log.warn(`state handler threw: ${(e as Error).message}`);
        }
      }
    });

    this.room.onError((code, message) => {
      log.error(`room error ${code}: ${message ?? ''}`);
    });

    this.room.onLeave((code) => {
      this.closed = true;
      log.info(`left room (code ${code})`);
      for (const fn of this.leaveHandlers) {
        try {
          fn(code);
        } catch {
          /* ignore */
        }
      }
    });
  }

  /**
   * Send a client action. These carry no signature and cannot move funds —
   * see src/wallet/signer.ts for why that matters.
   */
  send(type: string, payload?: unknown): void {
    if (!this.room || this.closed) {
      throw new Error(`cannot send "${type}": not connected`);
    }
    this.room.send(type, payload as never);
  }

  async leave(consented = true): Promise<void> {
    this.closed = true;
    if (this.room) {
      try {
        await this.room.leave(consented);
      } catch {
        /* already gone */
      }
      this.room = null;
    }
  }
}

/** Production endpoint derivation, mirroring the client's `netEndpoint()`. */
export function zoneEndpoint(baseUrl: string): string {
  const u = new URL(baseUrl);
  return u.protocol === 'https:' ? `wss://${u.host}` : `ws://${u.hostname}:2567`;
}
