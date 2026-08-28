/**
 * Lobby → dungeon entry.
 *
 * The town room is a social hub: its `mobs` collection is always empty, which
 * is why a bot that only joins town produces nothing at all. Monsters, drops
 * and chests live in dungeon rooms, and those are reached through the lobby:
 *
 *     joinOrCreate("lobby", { token })
 *     send    l.solo.enter   { atCol, atRow, startDepth }
 *     receive l.reservation  -> a Colyseus seat reservation
 *     client.consumeSeatReservation(reservation) -> the dungeon room
 *
 * A refusal arrives as `l.denied { action, reason }` rather than an exception,
 * so it has to be handled as data, not as a thrown error.
 *
 * All of this was recovered from the production bundle's `Ht` (client→server)
 * and `Jl` (server→client) constant maps.
 */

import { Client, Room } from 'colyseus.js';
import { xpCurveVersion } from './zone.js';
import { logger } from '../log.js';

const log = logger('lobby');

/** Client → server, lobby room. */
export const LOBBY_OUT = {
  PARTY_CREATE: 'l.party.create',
  PARTY_JOIN: 'l.party.join',
  PARTY_LEAVE: 'l.party.leave',
  PARTY_KICK: 'l.party.kick',
  PARTY_DISBAND: 'l.party.disband',
  ENTER_PARTY: 'l.party.enter',
  ENTER_SOLO: 'l.solo.enter',
  ENTER_RANKED: 'l.ranked.enter',
  ENTRY_INFO: 'l.entryinfo',
  ABANDON: 'l.abandon',
  RESUME: 'l.resume',
  DESCEND: 'l.descend',
} as const;

/** Server → client, lobby room. */
export const LOBBY_IN = {
  PARTY: 'l.party',
  RESERVATION: 'l.reservation',
  DENIED: 'l.denied',
  ENTRY_INFO: 'l.entryinfo',
} as const;

export interface EntryOptions {
  endpoint: string;
  token: string;
  /** Where the hero stands when entering; the server validates proximity. */
  atCol: number;
  atRow: number;
  startDepth?: number;
  timeoutMs?: number;
}

export class EntryDeniedError extends Error {
  constructor(
    readonly action: string,
    readonly reason: string,
  ) {
    super(`dungeon entry denied (${action}): ${reason}`);
    this.name = 'EntryDeniedError';
  }
}

export interface DungeonEntry {
  /** The joined dungeon room. */
  room: Room;
  /** Kept so the caller can close it once the run ends. */
  client: Client;
}

/**
 * Enter a solo dungeon run and return the joined dungeon room.
 *
 * `resume` is attempted first: an interrupted run leaves the character inside a
 * dungeon, and starting a fresh one without resuming abandons the progress (and
 * any loot) already earned.
 */
export async function enterSoloDungeon(opts: EntryOptions): Promise<DungeonEntry> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const client = new Client(opts.endpoint);
  client.auth.token = opts.token;

  const lobby = await client.joinOrCreate('lobby', {
    token: opts.token,
    xpCurveVersion: xpCurveVersion(),
  });

  try {
    const reservation = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no lobby reservation within ${timeoutMs}ms`)),
        timeoutMs,
      );
      const done = (fn: () => void): void => {
        clearTimeout(timer);
        fn();
      };

      lobby.onMessage(LOBBY_IN.RESERVATION, (payload: { reservation?: unknown }) => {
        const r = payload?.reservation ?? payload;
        done(() => resolve(r));
      });

      lobby.onMessage(LOBBY_IN.DENIED, (payload: { action?: string; reason?: string }) => {
        done(() =>
          reject(new EntryDeniedError(payload?.action ?? 'enter', payload?.reason ?? 'unknown')),
        );
      });

      lobby.onError((code, message) => {
        done(() => reject(new Error(`lobby error ${code}: ${message ?? ''}`)));
      });

      // Ask what the server thinks our entry state is, then try to resume an
      // interrupted run before starting a new one.
      lobby.send(LOBBY_OUT.ENTRY_INFO, {});
      lobby.send(LOBBY_OUT.RESUME, {});
      setTimeout(() => {
        lobby.send(LOBBY_OUT.ENTER_SOLO, {
          atCol: Math.round(opts.atCol),
          atRow: Math.round(opts.atRow),
          startDepth: opts.startDepth ?? 1,
        });
      }, 1_500);
    });

    if (!reservation) throw new Error('lobby returned an empty reservation');

    log.info('reservation received, joining dungeon');
    const room = await client.consumeSeatReservation(reservation as never);
    log.info(`joined dungeon as session ${room.sessionId}`);

    // The lobby has done its job; holding it open wastes a connection.
    await lobby.leave(true).catch(() => {});
    return { room, client };
  } catch (err) {
    await lobby.leave(true).catch(() => {});
    throw err;
  }
}

/** Server → client, dungeon room. Recovered from the bundle's `De` map. */
export const DUNGEON_IN = {
  ROSTER: 'd.party',
  EXIT: 'd.exit',
  FLOOR_CLEARED: 'd.cleared',
  RANKED_STATUS: 'd.ranked.status',
  BOSS_LOOT: 'd.bossloot',
  DROP_SPAWN: 'd.drop.spawn',
  DROP_REMOVE: 'd.drop.remove',
  PICKUP_DENIED: 'd.drop.denied',
  CHEST_OPENED: 'd.chest.opened',
  CHEST_STATE: 'd.chest.state',
  CHEST_SPAWNED: 'd.chest.spawned',
  SHINY_STATE: 'd.shiny.state',
  DESCEND_PENDING: 'd.descend.pending',
  DESCEND_DENIED: 'd.descend.denied',
  DESCEND: 'd.descend',
  SUMMARY: 'd.summary',
  RUN_TRIGGERED: 'd.run.triggered',
  FOUNTAIN_STATE: 'd.fountain.state',
  FOUNTAIN_GRANT: 'd.fountain.grant',
  RESURRECTION_STATE: 'd.resurrection.state',
  RESURRECTION_GRANT: 'd.resurrection.grant',
  RESURRECTION_TRIGGERED: 'd.resurrection.triggered',
} as const;

/** Message types that mean real value was produced, for the ledger. */
export const VALUE_SIGNALS: readonly string[] = [
  DUNGEON_IN.DROP_SPAWN,
  DUNGEON_IN.BOSS_LOOT,
  DUNGEON_IN.CHEST_OPENED,
  DUNGEON_IN.FLOOR_CLEARED,
] as const;
