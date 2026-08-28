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

describe('prompt rendering carries no secrets', () => {
  it('includes ids and facts but nothing key-shaped', () => {
    const out = renderRequest(req);
    expect(out).toContain('id=b');
    expect(out).toContain('Ember Ring');
    expect(out).not.toMatch(/sk-|eyJ|Bearer/);
  });
});
