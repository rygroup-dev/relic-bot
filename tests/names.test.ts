import { describe, it, expect } from 'vitest';
import {
  generateName,
  generateNames,
  isValidName,
  isProfane,
  normalise,
  NAME_RE,
  NAME_MIN,
  NAME_MAX,
} from '../src/game/names.js';
import { CLASSES } from '../src/protocol/messages.js';
import { chooseClass } from '../src/game/onboard.js';

describe('name validation mirrors the game client', () => {
  it('accepts ordinary hero names', () => {
    for (const n of ['Ka', 'Rowan', 'Aldric Ironhold', "D'Argo", 'Nyx_7', 'Sable-Rook']) {
      expect(isValidName(n), n).toBe(true);
    }
  });

  it('rejects names outside 2..20 characters', () => {
    expect(isValidName('A')).toBe(false);
    expect(isValidName('A'.repeat(NAME_MAX + 1))).toBe(false);
    expect(isValidName('A'.repeat(NAME_MAX))).toBe(true);
    expect(NAME_MIN).toBe(2);
  });

  it('rejects punctuation at the very start or end', () => {
    for (const n of ['-Rowan', "Rowan'", '_Nyx', 'Rowan-']) {
      expect(isValidName(n), n).toBe(false);
    }
  });

  it('trims surrounding whitespace rather than rejecting it', () => {
    // The client normalises with trim + whitespace collapse before validating,
    // so a padded paste is accepted, not refused.
    expect(isValidName(' Rowan ')).toBe(true);
    expect(normalise(' Rowan ')).toBe('Rowan');
  });

  it('rejects characters the client regex disallows', () => {
    for (const n of ['Ro@wan', 'Ro.wan', 'Ro!wan', 'Röwan', 'Ro/wan']) {
      expect(isValidName(n), n).toBe(false);
    }
  });

  it('screens profanity the same way the client does', () => {
    expect(isProfane('shitlord')).toBe(true);
    // The client strips to [a-z0-9] first, so separators do not evade it.
    expect(isProfane("s h i t")).toBe(true);
    expect(isProfane('S-H-I-T')).toBe(true);
    expect(isProfane('Aldric')).toBe(false);
  });

  it('collapses internal whitespace when normalising', () => {
    expect(normalise('  Aldric   Ironhold ')).toBe('Aldric Ironhold');
  });
});

describe('generated names are always usable', () => {
  it('produces a valid name for every class, repeatedly', () => {
    for (const c of CLASSES) {
      for (let i = 0; i < 200; i++) {
        const n = generateName(c);
        expect(isValidName(n), `${c}: ${n}`).toBe(true);
        expect(NAME_RE.test(n), `${c}: ${n}`).toBe(true);
        expect(n.length).toBeLessThanOrEqual(NAME_MAX);
      }
    }
  });

  it('is deterministic under a seeded rng', () => {
    const seeded = () => 0.5;
    expect(generateName('knight', { rng: seeded })).toBe(
      generateName('knight', { rng: seeded }),
    );
  });

  it('avoids names already taken', () => {
    const first = generateName('mage', { rng: () => 0.5 });
    const second = generateName('mage', {
      rng: () => 0.5,
      taken: new Set([first.toLowerCase()]),
    });
    expect(second).not.toBe(first);
    expect(isValidName(second)).toBe(true);
  });

  it('gives each class its own flavour', () => {
    const necro = new Set(Array.from({ length: 60 }, () => generateName('necromancer')));
    const knight = new Set(Array.from({ length: 60 }, () => generateName('knight')));
    // The pools are disjoint, so a large sample should not overlap.
    for (const n of necro) expect(knight.has(n)).toBe(false);
  });
});

describe('batch generation', () => {
  it('returns the requested count with no duplicates', () => {
    const names = generateNames('rogue', 10);
    expect(names).toHaveLength(10);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(10);
    for (const n of names) expect(isValidName(n)).toBe(true);
  });

  it('does not collide with pre-existing names', () => {
    const existing = generateNames('hunter', 5);
    const more = generateNames('hunter', 5, {
      taken: new Set(existing.map((n) => n.toLowerCase())),
    });
    for (const n of more) expect(existing).not.toContain(n);
  });

  it('can still fill a batch larger than the epithet pool', () => {
    const names = generateNames('assassin', 40);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(40);
  });
});

describe('class selection for a fresh wallet', () => {
  it('prefers durable classes when the server leaves it open', () => {
    expect(chooseClass([], [])).toBe('knight');
  });

  it('treats an empty unlocks array as unrestricted, not as nothing available', () => {
    // The client itself falls open here; guessing "locked" would refuse to
    // create any character at all.
    expect(chooseClass([], [])).not.toBeNull();
  });

  it('honours the server unlock list', () => {
    expect(chooseClass(['mage'], [])).toBe('mage');
    expect(chooseClass(['rogue', 'mage'], [])).toBe('rogue');
  });

  it('skips classes the wallet already owns', () => {
    expect(chooseClass([], ['knight'])).toBe('hunter');
    expect(chooseClass(['knight'], ['knight'])).toBeNull();
  });

  it('returns null when nothing is left', () => {
    expect(chooseClass([], [...CLASSES])).toBeNull();
  });

  it('only ever returns a real class id', () => {
    for (const unlocks of [[], ['mage'], ['rogue', 'assassin'], [...CLASSES]]) {
      const c = chooseClass(unlocks, []);
      if (c !== null) expect(CLASSES).toContain(c);
    }
  });
});
