import { describe, it, expect, vi } from 'vitest';
import { Otak, heuristicPick } from '../src/otak/index.js';
import { parseReply, renderRequest, type OtakProvider, type OtakRequest } from '../src/otak/types.js';

const req: OtakRequest = {
  domain: 'economy',
  situation: 'three items could be listed',
  candidates: [
    { id: 'a', label: 'Rusted Blade', score: 0.4, rationale: 'low value' },
    { id: 'b', label: 'Ember Ring', score: 0.9, rationale: 'best net after fee' },
    { id: 'c', label: 'Cracked Gem', score: 0.6, rationale: 'mid' },
  ],
};

function stub(name: OtakProvider['name'], reply: Partial<{ chosenId: string | null; confidence: number }>): OtakProvider {
  return {
    name,
    health: async () => ({ ok: true, detail: 'stub' }),
    decide: async () => ({
      chosenId: reply.chosenId === undefined ? 'a' : reply.chosenId,
      confidence: reply.confidence ?? 0.9,
      reasoning: 'stub reasoning',
    }),
  };
}

const opts = { enabled: true, timeoutMs: 1_000, maxCallsPerHour: 100 };

describe('bot runs fully without any LLM', () => {
  it('falls back to the top-scoring heuristic candidate when disabled', async () => {
    const o = new Otak({ ...opts, enabled: false });
    const d = await o.decide(req);
    expect(d.source).toBe('heuristic');
    expect(d.chosenId).toBe('b');
  });

  it('returns null rather than guessing when there are no candidates', () => {
    const d = heuristicPick({ domain: 'combat', situation: 's', candidates: [] });
    expect(d.chosenId).toBeNull();
  });

  it('uses the heuristic when no providers are registered', async () => {
    const o = new Otak(opts);
    expect(o.enabled).toBe(false);
    expect((await o.decide(req)).source).toBe('heuristic');
  });
});

describe('GUARDRAIL: the LLM can never invent an action', () => {
  it('rejects an id that was not offered and falls back', async () => {
    const o = new Otak(opts);
    o.setProviders([stub('openai', { chosenId: 'DROP_TABLE_or_buy_everything' })]);
    const d = await o.decide(req);
    expect(d.source).toBe('heuristic');
    expect(d.chosenId).toBe('b');
  });

  it('accepts a valid id and marks it as an llm decision', async () => {
    const o = new Otak(opts);
    o.setProviders([stub('anthropic', { chosenId: 'c' })]);
    const d = await o.decide(req);
    expect(d.source).toBe('llm');
    expect(d.chosenId).toBe('c');
    expect(d.provider).toBe('anthropic');
  });

  it('honours an explicit decline', async () => {
    const o = new Otak(opts);
    o.setProviders([stub('anthropic', { chosenId: null })]);
    const d = await o.decide(req);
    expect(d.chosenId).toBeNull();
  });

  it('ignores a low-confidence override', async () => {
    const o = new Otak({ ...opts, minConfidence: 0.7 });
    o.setProviders([stub('openai', { chosenId: 'a', confidence: 0.2 })]);
    const d = await o.decide(req);
    expect(d.source).toBe('heuristic');
  });
});

describe('provider fallback chain (Sakana 401 lesson)', () => {
  it('falls through a failing provider to the next one', async () => {
    const bad: OtakProvider = {
      name: 'fugu',
      health: async () => ({ ok: false, detail: '401' }),
      decide: async () => {
        throw new Error('fugu 401: unauthorized');
      },
    };
    const o = new Otak(opts);
    o.setProviders([bad, stub('anthropic', { chosenId: 'a' })]);
    const d = await o.decide(req);
    expect(d.source).toBe('llm');
    expect(d.provider).toBe('anthropic');
  });

  it('falls back to heuristics when every provider throws', async () => {
    const dead = (name: OtakProvider['name']): OtakProvider => ({
      name,
      health: async () => ({ ok: false, detail: 'dead' }),
      decide: async () => {
        throw new Error('network');
      },
    });
    const o = new Otak(opts);
    o.setProviders([dead('openai'), dead('anthropic'), dead('fugu')]);
    const d = await o.decide(req);
    expect(d.source).toBe('heuristic');
    expect(d.chosenId).toBe('b');
  });

  it('stops calling once the hourly budget is spent', async () => {
    const decide = vi.fn(async () => ({ chosenId: 'a', confidence: 0.9, reasoning: '' }));
    const o = new Otak({ ...opts, maxCallsPerHour: 2 });
    o.setProviders([{ name: 'openai', health: async () => ({ ok: true, detail: '' }), decide }]);
    await o.decide(req);
    await o.decide(req);
    const third = await o.decide(req);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(third.source).toBe('heuristic');
  });
});

describe('reply parsing', () => {
  it('parses a bare JSON object', () => {
    expect(parseReply('{"chosenId":"a","confidence":0.5,"reasoning":"x"}')).toEqual({
      chosenId: 'a',
      confidence: 0.5,
      reasoning: 'x',
    });
  });

  it('strips markdown fences', () => {
    const r = parseReply('```json\n{"chosenId":"b","confidence":1,"reasoning":"y"}\n```');
    expect(r.chosenId).toBe('b');
  });

  it('clamps an out-of-range confidence', () => {
    expect(parseReply('{"chosenId":"a","confidence":99,"reasoning":""}').confidence).toBe(1);
    expect(parseReply('{"chosenId":"a","confidence":-5,"reasoning":""}').confidence).toBe(0);
  });

  it('coerces a missing or empty chosenId to null', () => {
    expect(parseReply('{"confidence":1,"reasoning":"x"}').chosenId).toBeNull();
    expect(parseReply('{"chosenId":"","confidence":1,"reasoning":"x"}').chosenId).toBeNull();
  });
});

describe('prompt rendering is compact and secret-free', () => {
  it('carries every candidate id and label', () => {
    const out = renderRequest(req);
    for (const c of req.candidates) {
      expect(out).toContain(c.id);
      expect(out).toContain(c.label);
    }
  });

  it('never leaks key-shaped material', () => {
    expect(renderRequest(req)).not.toMatch(/sk-|eyJ|Bearer/);
  });

  it('spends one short line per candidate', () => {
    // This block is billed on every Otak call, so its size is a cost decision,
    // not a cosmetic one. Guard against it creeping back into paragraphs.
    const lines = renderRequest(req).split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(req.candidates.length);
    for (const l of lines) expect(l.length).toBeLessThan(90);
  });
});

describe('one brain drives the whole fleet, and OFF is not degraded', () => {
  const many: OtakRequest = {
    domain: 'combat',
    situation: 'three targets',
    candidates: [
      { id: 'attack:a', label: 'troll', score: 0.3, rationale: 'far' },
      { id: 'attack:b', label: 'rat', score: 0.8, rationale: 'near, wounded' },
      { id: 'attack:c', label: 'ogre', score: 0.5, rationale: 'mid' },
    ],
  };

  it('serves every wallet from a single instance', async () => {
    // The fleet constructs one Otak and hands the same reference to every
    // AccountRunner, so enabling it lights up all wallets at once — existing
    // and newly minted alike.
    const o = new Otak(opts);
    o.setProviders([stub('anthropic', { chosenId: 'attack:c' })]);

    const perWallet = await Promise.all(
      ['wallet-01', 'wallet-02', 'wallet-03'].map(() => o.decide(many)),
    );
    for (const d of perWallet) {
      expect(d.source).toBe('llm');
      expect(d.chosenId).toBe('attack:c');
    }
  });

  it('still decides on every wallet with the brain switched off', async () => {
    const o = new Otak({ ...opts, enabled: false });
    for (const _ of ['wallet-01', 'wallet-02', 'wallet-03']) {
      const d = await o.decide(many);
      // Same shape of answer, same action space — just chosen by the
      // deterministic policy instead of the model.
      expect(d.chosenId).toBe('attack:b');
      expect(d.source).toBe('heuristic');
    }
  });

  it('can only ever pick from what the heuristics already offered', async () => {
    // This is the boundary of "more powerful": the model re-ranks, it does not
    // gain new abilities. Anything outside the candidate set is discarded.
    const o = new Otak(opts);
    o.setProviders([stub('anthropic', { chosenId: 'attack:dragon-not-offered' })]);
    const d = await o.decide(many);
    expect(d.source).toBe('heuristic');
    expect(many.candidates.map((c) => c.id)).toContain(d.chosenId);
  });

  it('toggles at runtime without restarting the fleet', async () => {
    const o = new Otak({ ...opts, enabled: false });
    o.setProviders([stub('openai', { chosenId: 'attack:c' })]);
    expect((await o.decide(many)).source).toBe('heuristic');
    o.setEnabled(true);
    expect((await o.decide(many)).source).toBe('llm');
    o.setEnabled(false);
    expect((await o.decide(many)).source).toBe('heuristic');
  });
});

describe('the brain\'s work is visible and measurable', () => {
  const two: OtakRequest = {
    domain: 'combat',
    situation: 'two targets',
    candidates: [
      { id: 'a', label: 'rat', score: 0.9, rationale: 'easy' },
      { id: 'b', label: 'ogre', score: 0.4, rationale: 'hard' },
    ],
  };

  it('records a heuristic decision even with the brain off', async () => {
    const o = new Otak({ ...opts, enabled: false });
    await o.decide(two);
    const [d] = o.recentDecisions();
    expect(d!.source).toBe('heuristic');
    expect(d!.chosenId).toBe('a');
    expect(o.stats().heuristic).toBe(1);
  });

  it('marks an override so a real change is distinguishable from agreement', async () => {
    const o = new Otak(opts);
    o.setProviders([stub('anthropic', { chosenId: 'b' })]);
    await o.decide(two);
    const [d] = o.recentDecisions();
    expect(d!.source).toBe('llm');
    expect(d!.overrode).toBe(true);
    expect(d!.heuristicChoice).toBe('a');
    expect(o.stats().overrides).toBe(1);
    expect(o.stats().overrideRate).toBe(1);
  });

  it('does not count agreement as an override', async () => {
    const o = new Otak(opts);
    o.setProviders([stub('anthropic', { chosenId: 'a' })]);
    await o.decide(two);
    expect(o.recentDecisions()[0]!.overrode).toBe(false);
    expect(o.stats().overrideRate).toBe(0);
  });

  it('counts guardrail rejections separately from decisions', async () => {
    const o = new Otak(opts);
    o.setProviders([stub('openai', { chosenId: 'not-a-real-id' })]);
    await o.decide(two);
    expect(o.stats().rejected).toBe(1);
  });

  it('keeps history bounded and newest-first', async () => {
    const o = new Otak({ ...opts, enabled: false });
    for (let i = 0; i < 60; i++) await o.decide(two);
    const recent = o.recentDecisions(100);
    expect(recent.length).toBeLessThanOrEqual(40);
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i - 1]!.at).toBeGreaterThanOrEqual(recent[i]!.at);
    }
  });

  it('reports a zero override rate before any model call', () => {
    expect(new Otak(opts).stats().overrideRate).toBe(0);
  });
});
