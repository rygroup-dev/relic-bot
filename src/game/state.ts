/**
 * Tolerant view over the Colyseus room state.
 *
 * IMPORTANT — what is and is not verified:
 * The client->server message vocabulary was fully recovered from the bundle
 * (68 types, see protocol/messages.ts). The server->client STATE SHAPE was not:
 * Colyseus 0.16 sends schema definitions by reflection at handshake time, so
 * the field names exist only at runtime, not as literals in the bundle.
 *
 * This module therefore reads state defensively — it probes several plausible
 * field names and returns null rather than guessing. `describeUnknownState` is
 * provided so a first run can dump the real shape, after which these accessors
 * can be tightened against observed reality instead of assumption.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface EntityView {
  id: string;
  kind: 'player' | 'monster' | 'loot' | 'npc' | 'unknown';
  name: string;
  pos: Vec2 | null;
  hp: number | null;
  maxHp: number | null;
  level: number | null;
  raw: unknown;
}

export interface SelfView {
  id: string | null;
  pos: Vec2 | null;
  hp: number | null;
  maxHp: number | null;
  level: number | null;
  gold: number | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pick(obj: unknown, keys: readonly string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    if (rec[k] !== undefined) return rec[k];
  }
  return undefined;
}

export function readPos(o: unknown): Vec2 | null {
  const x = num(pick(o, ['x', 'posX', 'col']));
  const y = num(pick(o, ['y', 'posY', 'row']));
  return x !== null && y !== null ? { x, y } : null;
}

/** Iterate a Colyseus MapSchema/ArraySchema or a plain object/array. */
export function iterCollection(c: unknown): [string, unknown][] {
  if (!c) return [];
  if (Array.isArray(c)) return c.map((v, i) => [String(i), v] as [string, unknown]);
  const anyC = c as { forEach?: (cb: (v: unknown, k: unknown) => void) => void };
  if (typeof anyC.forEach === 'function') {
    const out: [string, unknown][] = [];
    anyC.forEach((v, k) => out.push([String(k), v]));
    return out;
  }
  if (typeof c === 'object') {
    return Object.entries(c as Record<string, unknown>);
  }
  return [];
}

function classify(key: string, v: unknown): EntityView['kind'] {
  const k = key.toLowerCase();
  if (/monster|enemy|mob|creature/.test(k)) return 'monster';
  if (/loot|drop|item/.test(k)) return 'loot';
  if (/player|hero|character/.test(k)) return 'player';
  if (/npc/.test(k)) return 'npc';
  const t = String(pick(v, ['type', 'kind', 'entityType']) ?? '').toLowerCase();
  if (/monster|enemy|mob/.test(t)) return 'monster';
  if (/loot|drop/.test(t)) return 'loot';
  if (/npc/.test(t)) return 'npc';
  if (/player|hero/.test(t)) return 'player';
  return 'unknown';
}

/** Extract every entity-like record the state exposes. */
export function readEntities(state: unknown): EntityView[] {
  if (!state || typeof state !== 'object') return [];
  const out: EntityView[] = [];

  for (const [collectionKey, collection] of Object.entries(state as Record<string, unknown>)) {
    const entries = iterCollection(collection);
    if (entries.length === 0) continue;

    for (const [id, v] of entries) {
      if (!v || typeof v !== 'object') continue;
      const pos = readPos(v);
      const hp = num(pick(v, ['hp', 'health', 'currentHp']));
      // Something with neither a position nor hp is almost certainly config,
      // not an entity. Skip rather than pollute the candidate list.
      if (pos === null && hp === null) continue;

      out.push({
        id: String(pick(v, ['id', 'sessionId', 'entityId']) ?? id),
        kind: classify(collectionKey, v),
        name: String(pick(v, ['name', 'label', 'displayName', 'monsterId']) ?? collectionKey),
        pos,
        hp,
        maxHp: num(pick(v, ['maxHp', 'hpMax', 'maxHealth'])),
        level: num(pick(v, ['level', 'lvl', 'depth'])),
        raw: v,
      });
    }
  }
  return out;
}

export function readSelf(state: unknown, sessionId: string | null): SelfView {
  const empty: SelfView = { id: sessionId, pos: null, hp: null, maxHp: null, level: null, gold: null };
  if (!state || typeof state !== 'object' || !sessionId) return empty;

  for (const [, collection] of Object.entries(state as Record<string, unknown>)) {
    for (const [k, v] of iterCollection(collection)) {
      if (k !== sessionId) continue;
      return {
        id: sessionId,
        pos: readPos(v),
        hp: num(pick(v, ['hp', 'health', 'currentHp'])),
        maxHp: num(pick(v, ['maxHp', 'hpMax', 'maxHealth'])),
        level: num(pick(v, ['level', 'lvl'])),
        gold: num(pick(v, ['gold', 'coins'])),
      };
    }
  }
  return empty;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** First-run diagnostic: dump the observed state shape so the accessors above
 *  can be tightened against reality rather than assumption. */
export function describeUnknownState(state: unknown, maxDepth = 2): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v !== 'object') return typeof v;
    if (seen.has(v as object)) return '<circular>';
    seen.add(v as object);
    if (depth >= maxDepth) return Array.isArray(v) ? `array[${v.length}]` : 'object';
    const entries = iterCollection(v).slice(0, 5);
    const o: Record<string, unknown> = {};
    for (const [k, val] of entries) o[k] = walk(val, depth + 1);
    return o;
  };
  return JSON.stringify(walk(state, 0), null, 2);
}
