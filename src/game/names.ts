/**
 * Hero name generation.
 *
 * Names are PERMANENT — the game states this in its own creation dialog — so a
 * generated name has to be something the operator is happy to live with, not a
 * random string. Each class gets its own vocabulary so a necromancer does not
 * end up called "Sunwarden".
 *
 * Every candidate is validated against the client's own rules before it is
 * offered:
 *   - regex  /^[A-Za-z0-9][A-Za-z0-9 _'-]{0,18}[A-Za-z0-9]$/
 *   - length 2..20
 *   - the client's profanity screen (letters-and-digits, lowercased, substring)
 */

import type { ClassId } from '../protocol/messages.js';

export const NAME_MIN = 2;
export const NAME_MAX = 20;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _'-]{0,18}[A-Za-z0-9]$/;

/**
 * The client screens names by stripping to [a-z0-9] and testing for these as
 * substrings. Reproduced so a generated name can never be rejected — and so
 * the check happens locally rather than as a failed round trip.
 */
const BLOCKED = ['nigger', 'faggot', 'fuck', 'shit', 'cunt'] as const;

export function normalise(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function isProfane(name: string): boolean {
  const flat = normalise(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  return BLOCKED.some((w) => flat.includes(w));
}

export function isValidName(name: string): boolean {
  const n = normalise(name);
  if (n.length < NAME_MIN || n.length > NAME_MAX) return false;
  if (!NAME_RE.test(n)) return false;
  return !isProfane(n);
}

/** First-name pools, chosen to sound like a person rather than a generator. */
const FIRST: Record<ClassId, readonly string[]> = {
  hunter: ['Ardan', 'Bryn', 'Coran', 'Elric', 'Fenn', 'Garen', 'Kaelen', 'Rowan', 'Sylas', 'Tarian'],
  mage: ['Alaric', 'Cassian', 'Emrys', 'Ilyas', 'Lorien', 'Merrick', 'Orin', 'Sorrel', 'Thaddeus', 'Valen'],
  necromancer: ['Ashen', 'Corvin', 'Dreven', 'Grimm', 'Malachai', 'Mortis', 'Nyx', 'Vareth', 'Xandros', 'Zarek'],
  knight: ['Aldric', 'Bertram', 'Cedric', 'Godfrey', 'Lucan', 'Percival', 'Roland', 'Tristan', 'Ulric', 'Wulfric'],
  assassin: ['Ash', 'Corvo', 'Dax', 'Kieran', 'Nero', 'Raven', 'Shade', 'Slyder', 'Vex', 'Zephyr'],
  rogue: ['Brix', 'Dodge', 'Finn', 'Jax', 'Kit', 'Nix', 'Pike', 'Quill', 'Rook', 'Sable'],
};

/** Epithets. Kept short so `First Epithet` stays inside 20 characters. */
const EPITHET: Record<ClassId, readonly string[]> = {
  hunter: ['Fletch', 'Wildeye', 'Trail', 'Hawke', 'Thorn', 'Vale'],
  mage: ['Arcane', 'Emberly', 'Runeis', 'Starke', 'Wyrde', 'Zephyr'],
  necromancer: ['Bonecall', 'Gravely', 'Hollow', 'Palegast', 'Requiem', 'Wraithe'],
  knight: ['Ironhold', 'Steelbrand', 'Bulwark', 'Oathe', 'Ramparte', 'Vanguarde'],
  assassin: ['Quiet', 'Nightfall', 'Silente', 'Umbra', 'Whisper', 'Voidde'],
  rogue: ['Quickhand', 'Lightfoot', 'Sly', 'Pocketts', 'Shadowe', 'Trickster'],
};

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

export interface NameOptions {
  /** Injectable for deterministic tests. */
  rng?: () => number;
  /** Names already taken, so a fleet does not end up with duplicates. */
  taken?: ReadonlySet<string>;
}

/**
 * Generate a valid, class-appropriate hero name.
 *
 * Tries "First Epithet" first because it reads best, falls back to a bare first
 * name, then to a numbered variant. Throws rather than returning something
 * invalid — a permanent name is not a place to silently degrade.
 */
export function generateName(classId: ClassId, opts: NameOptions = {}): string {
  const rng = opts.rng ?? Math.random;
  const taken = opts.taken ?? new Set<string>();
  const firsts = FIRST[classId];
  const epithets = EPITHET[classId];

  const candidates: string[] = [];

  for (let i = 0; i < 40; i++) {
    candidates.push(`${pick(firsts, rng)} ${pick(epithets, rng)}`);
  }
  for (const f of firsts) candidates.push(f);
  for (const f of firsts) {
    for (let n = 2; n <= 99; n++) candidates.push(`${f}${n}`);
  }

  for (const c of candidates) {
    const n = normalise(c);
    if (!isValidName(n)) continue;
    if (taken.has(n.toLowerCase())) continue;
    return n;
  }

  throw new Error(`could not generate a valid ${classId} name`);
}

/** Distinct names for a batch, so bulk minting never collides with itself. */
export function generateNames(
  classId: ClassId,
  count: number,
  opts: NameOptions = {},
): string[] {
  const taken = new Set<string>([...(opts.taken ?? [])].map((s) => s.toLowerCase()));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const base: NameOptions = { taken };
    if (opts.rng) base.rng = opts.rng;
    const n = generateName(classId, base);
    out.push(n);
    taken.add(n.toLowerCase());
  }
  return out;
}
