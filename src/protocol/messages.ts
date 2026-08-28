/**
 * Client -> server message types, reverse-engineered from the production
 * bundle `NetTestScene-CBTdmlxc.js` (colyseus.js 0.16.22).
 *
 * These travel over the Colyseus WebSocket and require NO signature of any
 * kind. Nothing in this file can move funds.
 */

export const MSG = {
  // --- movement & core combat ---
  MOVE: 'i.move',
  ATTACK: 'i.attack',
  CAST: 'i.cast',
  ROLL: 'i.roll',
  USE: 'i.use',
  USE_INSTANCE: 'i.use.instance',
  REVIVE: 'i.revive',
  INSPECT: 'i.inspect',

  // --- loot & inventory ---
  LOOT_PICKUP: 'i.loot.pickup',
  CHEST_OPEN: 'i.chest.open',
  MYSTERYBOX_OPEN: 'i.mysterybox.open',
  INV_EQUIP: 'i.inv.equip',
  INV_UNEQUIP: 'i.inv.unequip',
  INV_DISCARD: 'i.inv.discard',
  INV_DESTROY_JUNK: 'i.inv.destroyjunk',

  // --- storage ---
  STASH_DEPOSIT: 'i.stash.deposit',
  STASH_WITHDRAW: 'i.stash.withdraw',
  SATCHEL_DEPOSIT: 'i.satchel.deposit',
  SATCHEL_WITHDRAW: 'i.satchel.withdraw',
  SATCHEL_MOVE: 'i.satchel.move',

  // --- character build ---
  ATTRS_SET: 'i.attrs.set',
  TALENTS_SET: 'i.talents.set',

  // --- gems & artifacts ---
  GEM_SOCKET: 'i.gem.socket',
  GEM_UNSOCKET: 'i.gem.unsocket',
  CHISEL_APPLY: 'i.chisel.apply',
  ARTIFACT_STATE: 'i.artifact.state',
  ARTIFACT_EQUIP: 'i.artifact.equip',
  ARTIFACT_UNEQUIP: 'i.artifact.unequip',
  ARTIFACT_SPEND: 'i.artifact.spend',
  ARTIFACT_SOCKETS: 'i.artifact.sockets',
  ARTIFACT_STONE_SOCKET: 'i.artifact.stone.socket',
  ARTIFACT_STONE_UNSOCKET: 'i.artifact.stone.unsocket',

  // --- shops (gold-denominated, in-world; NOT the USDC/RELIC shop) ---
  SHOP_STOCK: 'i.shop.stock',
  SHOP_BUY: 'i.shop.buy',
  SHOP_SELL: 'i.shop.sell',
  WANDERING_OPEN: 'i.wandering.open',
  WANDERING_BUY: 'i.wandering.buy',

  // --- dungeon progression ---
  DESCEND_REQ: 'i.descend.req',
  DUNGEON_FOUNTAIN_USE: 'i.dungeon.fountain.use',
  DUNGEON_RESURRECTION_USE: 'i.dungeon.resurrection.use',

  // --- dungeon NPC interactions ---
  DUNGEON_ROLAND_INTERACT: 'i.dungeon.roland.interact',
  DUNGEON_ROLAND_AGGRO: 'i.dungeon.roland.aggro',
  DUNGEON_DELVER_INTERACT: 'i.dungeon.delver.interact',
  DUNGEON_NECROMANCER_INTERACT: 'i.dungeon.necromancer.interact',
  DUNGEON_APPARITION_KNIGHT_INTERACT: 'i.dungeon.apparition-knight.interact',
  DUNGEON_FALLEN_HUNTRESS_INTERACT: 'i.dungeon.fallen-huntress.interact',
  DUNGEON_MAD_PYROMANCER_INTERACT: 'i.dungeon.mad-pyromancer.interact',
  DUNGEON_KNIGHT_CORPSE_INTERACT: 'i.dungeon.knight-corpse.interact',
  DUNGEON_SLAIN_CRUSADER_INTERACT: 'i.dungeon.slain-crusader.interact',

  // --- rebirth ---
  REBIRTH_PREVIEW: 'i.rebirth.preview',
  REBIRTH_CONFIRM: 'i.rebirth.confirm',
  REBIRTH_HUD_DISMISS: 'i.rebirth.hud.dismiss',
  REBIRTH_TUTORIAL_DISMISS: 'i.rebirth.tutorial.dismiss',

  // --- pvp / duels ---
  DUEL_CHALLENGE: 'i.duel.challenge',
  DUEL_ACCEPT: 'i.duel.accept',
  DUEL_DECLINE: 'i.duel.decline',
  DUEL_PREF: 'i.duel.pref',
  POS_KILLSETTLE: 'i.pos.killsettle',
  RANKED_TICKET_CLAIM: 'i.ranked.ticket.claim',

  // --- chat & misc UI ---
  CHAT: 'i.chat',
  CHAT_HISTORY: 'i.chat.history',
  HARDCORE_DISMISS: 'i.hardcore.dismiss',
  LEVEL90_DISMISS: 'i.level90.dismiss',
  PORTAL_DISMISS: 'i.portal.dismiss',
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

/** Rooms observed in `joinOrCreate` call sites. */
export const ROOM = {
  TOWN: 'town',
  LOBBY: 'lobby',
  ARENA_LOBBY: 'arenaLobby',
} as const;

export type RoomName = (typeof ROOM)[keyof typeof ROOM];

/**
 * Server-side refusal / disconnect reasons observed in the client's error
 * handling. `classify` maps a raw error string onto how the fleet must react.
 *
 * This mapping is the direct fix for the SLCW failure mode where a benign-looking
 * refusal was retried forever at zero error count. Anything that is not
 * explicitly transient is treated as blocking.
 */
export const REFUSAL = {
  BANNED: 'banned',
  CLIENT_OUTDATED: 'client_outdated',
  DEVICE_BUSY: 'device_busy',
  RATE_LIMITED: 'rate_limited',
} as const;

export type RefusalKind =
  | 'banned'
  | 'client_outdated'
  | 'device_busy'
  | 'rate_limited'
  | 'unknown';

/** How the orchestrator must respond to a refusal. */
export type RefusalScope = 'fleet' | 'account' | 'retry';

export interface RefusalVerdict {
  kind: RefusalKind;
  scope: RefusalScope;
  /** Suggested backoff before the same action may be attempted again. */
  cooldownMs: number;
  /** True when a human must intervene; the orchestrator will alert. */
  needsOperator: boolean;
}

export function classifyRefusal(raw: unknown): RefusalVerdict {
  const s = String(
    (raw as { message?: unknown } | null)?.message ?? raw ?? '',
  ).toLowerCase();

  if (/banned/.test(s)) {
    return { kind: 'banned', scope: 'account', cooldownMs: Infinity, needsOperator: true };
  }
  if (/client_outdated/.test(s)) {
    // The deployed client moved on. Every account will fail identically, so
    // park the whole fleet rather than hammering N sessions into the same wall.
    return { kind: 'client_outdated', scope: 'fleet', cooldownMs: Infinity, needsOperator: true };
  }
  if (/device_busy/.test(s)) {
    return { kind: 'device_busy', scope: 'account', cooldownMs: 120_000, needsOperator: true };
  }
  if (/rate_limit/.test(s)) {
    return { kind: 'rate_limited', scope: 'account', cooldownMs: 60_000, needsOperator: false };
  }
  return { kind: 'unknown', scope: 'retry', cooldownMs: 15_000, needsOperator: false };
}
