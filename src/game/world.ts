/**
 * World map markers.
 *
 * `/world/{zone}.collision.json` is served publicly by the game and carries the
 * blocked cells plus named markers. The one that matters for automation is
 * `dungeonEntrance`: entering a dungeon is refused with `too_far` unless the
 * hero is standing on (or beside) the trapdoor, so the bot has to walk there
 * first rather than requesting entry from wherever it spawned.
 *
 * Marker arrays are flat cell indices; `index = col + row * cols`.
 */

import { logger } from '../log.js';

const log = logger('world');

export interface Cell {
  col: number;
  row: number;
}

export interface WorldMap {
  id: string;
  cols: number;
  rows: number;
  blocked: Set<number>;
  markers: Record<string, Cell[]>;
}

export function indexToCell(index: number, cols: number): Cell {
  return { col: index % cols, row: Math.floor(index / cols) };
}

export function cellToIndex(cell: Cell, cols: number): number {
  return cell.col + cell.row * cols;
}

interface RawCollision {
  meta?: { id?: string; cols?: number; rows?: number };
  blocked?: number[];
  markers?: Record<string, number[]>;
}

const cache = new Map<string, WorldMap>();

/** Fetch and parse a zone's collision map, cached for the process lifetime. */
export async function loadWorldMap(baseUrl: string, zoneId = 'town'): Promise<WorldMap | null> {
  const hit = cache.get(zoneId);
  if (hit) return hit;

  try {
    const res = await fetch(`${baseUrl}/world/${zoneId}.collision.json`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log.warn(`collision map for ${zoneId}: HTTP ${res.status}`);
      return null;
    }
    const raw = (await res.json()) as RawCollision;
    const cols = raw.meta?.cols ?? 0;
    const rows = raw.meta?.rows ?? 0;
    if (cols <= 0 || rows <= 0) {
      log.warn(`collision map for ${zoneId} has no usable dimensions`);
      return null;
    }

    const markers: Record<string, Cell[]> = {};
    for (const [name, list] of Object.entries(raw.markers ?? {})) {
      markers[name] = list.map((i) => indexToCell(i, cols));
    }

    const map: WorldMap = {
      id: raw.meta?.id ?? zoneId,
      cols,
      rows,
      blocked: new Set(raw.blocked ?? []),
      markers,
    };
    cache.set(zoneId, map);
    log.info(
      `loaded ${zoneId} map ${cols}x${rows}, markers: ` +
        Object.entries(markers)
          .map(([k, v]) => `${k}=${v.length}`)
          .join(' '),
    );
    return map;
  } catch (err) {
    log.warn(`could not load ${zoneId} collision map: ${(err as Error).message}`);
    return null;
  }
}

export function isBlocked(map: WorldMap, cell: Cell): boolean {
  if (cell.col < 0 || cell.row < 0 || cell.col >= map.cols || cell.row >= map.rows) return true;
  return map.blocked.has(cellToIndex(cell, map.cols));
}

/** The dungeon entrance, if this map has one. */
export function dungeonEntrance(map: WorldMap): Cell | null {
  return map.markers.dungeonEntrance?.[0] ?? null;
}

/**
 * Shortest walkable path between two cells (BFS, 4-directional).
 *
 * BFS rather than A* deliberately: town is 35x27, so the whole grid is under a
 * thousand cells and an exact shortest path costs nothing. Returns the cells to
 * step through, excluding the start. Null when no route exists.
 */
export function findPath(map: WorldMap, from: Cell, to: Cell, maxNodes = 5000): Cell[] | null {
  if (from.col === to.col && from.row === to.row) return [];

  const start = cellToIndex(from, map.cols);
  const goal = cellToIndex(to, map.cols);
  const prev = new Map<number, number>();
  const seen = new Set<number>([start]);
  const queue: number[] = [start];
  let visited = 0;

  while (queue.length > 0 && visited < maxNodes) {
    const cur = queue.shift()!;
    visited += 1;
    if (cur === goal) {
      const path: Cell[] = [];
      let node = goal;
      while (node !== start) {
        path.push(indexToCell(node, map.cols));
        const p = prev.get(node);
        if (p === undefined) return null;
        node = p;
      }
      return path.reverse();
    }

    const { col, row } = indexToCell(cur, map.cols);
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const next = { col: col + dc, row: row + dr };
      const ni = cellToIndex(next, map.cols);
      if (seen.has(ni)) continue;
      // The goal itself may be marked blocked (a trapdoor is scenery); allow it.
      if (ni !== goal && isBlocked(map, next)) continue;
      seen.add(ni);
      prev.set(ni, cur);
      queue.push(ni);
    }
  }
  return null;
}
