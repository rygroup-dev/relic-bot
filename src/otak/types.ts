/**
 * Otak — the decision layer.
 *
 * Contract: the LLM never invents an action. It receives a candidate list that
 * deterministic heuristics have already produced and validated, and may only
 * choose among them (or decline). Everything the bot can possibly do is
 * therefore bounded by the heuristics, not by the model's imagination.
 */

export type Domain = 'economy' | 'combat' | 'progression' | 'safety';

export interface Candidate {
  /** Stable identifier the model must echo back to select this option. */
  id: string;
  /** Short human/model-readable label. */
  label: string;
  /** Deterministic score from heuristics; higher is better. */
  score: number;
  /** Why the heuristics scored it this way. */
  rationale: string;
  /** Extra numeric facts the model may reason over. Never contains secrets. */
  facts?: Record<string, string | number | boolean>;
}

export interface OtakRequest {
  domain: Domain;
  /** One-paragraph description of the current situation. Sanitised. */
  situation: string;
  candidates: Candidate[];
  /** Free-form constraints the model must respect. */
  constraints?: string[];
}

export interface OtakDecision {
  /** Chosen candidate id, or null to take no action. */
  chosenId: string | null;
  confidence: number;
  reasoning: string;
  source: 'heuristic' | 'llm';
  provider?: string;
}

export interface ProviderReply {
  chosenId: string | null;
  confidence: number;
  reasoning: string;
}

export interface OtakProvider {
  readonly name: 'openai' | 'anthropic' | 'fugu';
  /** True when the provider has a usable key and answers a trivial probe. */
  health(): Promise<{ ok: boolean; detail: string }>;
  decide(req: OtakRequest, timeoutMs: number): Promise<ProviderReply>;
}

/** The instruction every provider receives. Identical across providers so
 *  switching provider does not silently change behaviour. */
export const OTAK_SYSTEM = [
  'You are "Otak", the advisory brain for an automated player in a dungeon-crawler game.',
  '',
  'You are given a list of candidate actions that a deterministic policy has already',
  'produced and validated. Your ONLY job is to choose the best candidate, or to decline.',
  '',
  'Hard rules:',
  '1. You MUST choose an id from the provided candidates, or return null to do nothing.',
  '2. You MUST NOT invent an action, id, item, price, or endpoint that is not listed.',
  '3. If the candidates look unsafe, low-value, or ambiguous, return null. Declining is',
  '   always acceptable and is preferred over a guess.',
  '4. Prefer sustained throughput over a single large risky gain.',
  '',
  'Respond with JSON only, matching:',
  '{"chosenId": <string|null>, "confidence": <number 0..1>, "reasoning": <string, max 240 chars>}',
].join('\n');

/** Compact, secret-free rendering of a request for the model. */
export function renderRequest(req: OtakRequest): string {
  const lines: string[] = [
    `Domain: ${req.domain}`,
    `Situation: ${req.situation}`,
    '',
    'Candidates:',
  ];
  // Kept deliberately terse: this block is the only part billed on every call,
  // so each candidate is one short line rather than a paragraph.
  for (const c of req.candidates) {
    const facts = c.facts
      ? ' ' +
        Object.entries(c.facts)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')
      : '';
    lines.push(`- ${c.id} s=${c.score.toFixed(2)} ${c.label}${facts}`);
  }
  if (req.constraints?.length) {
    lines.push('', 'Constraints:');
    for (const k of req.constraints) lines.push(`- ${k}`);
  }
  return lines.join('\n');
}

/** JSON shape the providers are constrained to. */
export const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['chosenId', 'confidence', 'reasoning'],
  properties: {
    chosenId: { type: ['string', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasoning: { type: 'string', maxLength: 240 },
  },
} as const;

/** Tolerant parse of a provider's JSON reply. */
export function parseReply(raw: string): ProviderReply {
  let text = raw.trim();
  // Strip markdown fences some models still emit.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) text = fence[1].trim();

  const obj = JSON.parse(text) as Partial<ProviderReply>;
  const chosenId =
    typeof obj.chosenId === 'string' && obj.chosenId.length > 0 ? obj.chosenId : null;
  const confidence =
    typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? Math.min(1, Math.max(0, obj.confidence))
      : 0;
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning.slice(0, 240) : '';
  return { chosenId, confidence, reasoning };
}
