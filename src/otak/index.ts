/**
 * Otak orchestrator.
 *
 * Layering:
 *   heuristics -> candidates  (deterministic, always runs)
 *   Otak LLM   -> re-rank     (optional; may only pick from candidates)
 *   guardrail  -> final veto   (rejects anything not in the candidate set)
 *
 * With the LLM disabled or every provider unhealthy, `decide` still returns the
 * heuristic's top candidate, so the bot plays fully without any API key.
 */

import type {
  OtakDecision,
  OtakProvider,
  OtakRequest,
  ProviderReply,
} from './types.js';
import { logger } from '../log.js';

const log = logger('otak');

export interface OtakOptions {
  enabled: boolean;
  timeoutMs: number;
  maxCallsPerHour: number;
  /** Minimum model confidence required to override the heuristic pick. */
  minConfidence?: number;
}

export interface ProviderHealth {
  name: string;
  ok: boolean;
  detail: string;
  checkedAt: number;
}

/** Heuristic fallback: the highest-scoring candidate, or none. */
export function heuristicPick(req: OtakRequest): OtakDecision {
  if (req.candidates.length === 0) {
    return {
      chosenId: null,
      confidence: 0,
      reasoning: 'no candidates passed the heuristic filter',
      source: 'heuristic',
    };
  }
  const best = req.candidates.reduce((a, b) => (b.score > a.score ? b : a));
  return {
    chosenId: best.id,
    confidence: Math.min(1, Math.max(0, best.score)),
    reasoning: best.rationale,
    source: 'heuristic',
  };
}

export class Otak {
  private providers: OtakProvider[] = [];
  private health = new Map<string, ProviderHealth>();
  private callTimes: number[] = [];

  constructor(private opts: OtakOptions) {}

  /** Register providers in fallback order. */
  setProviders(providers: OtakProvider[]): void {
    this.providers = providers;
    this.health.clear();
  }

  get enabled(): boolean {
    return this.opts.enabled && this.providers.length > 0;
  }

  setEnabled(on: boolean): void {
    this.opts.enabled = on;
    log.info(`otak ${on ? 'enabled' : 'disabled'}`);
  }

  async checkHealth(): Promise<ProviderHealth[]> {
    const out: ProviderHealth[] = [];
    for (const p of this.providers) {
      const r = await p.health().catch((e) => ({ ok: false, detail: (e as Error).message }));
      const h: ProviderHealth = { name: p.name, ...r, checkedAt: Date.now() };
      this.health.set(p.name, h);
      out.push(h);
      log.info(`provider ${p.name}: ${h.ok ? 'OK' : 'FAILED'} — ${h.detail}`);
    }
    return out;
  }

  healthSnapshot(): ProviderHealth[] {
    return [...this.health.values()];
  }

  /** Sliding-window budget so a stuck loop cannot burn the API quota. */
  private withinBudget(): boolean {
    const cutoff = Date.now() - 3_600_000;
    this.callTimes = this.callTimes.filter((t) => t > cutoff);
    return this.callTimes.length < this.opts.maxCallsPerHour;
  }

  async decide(req: OtakRequest): Promise<OtakDecision> {
    const fallback = heuristicPick(req);

    if (!this.enabled) return fallback;
    if (req.candidates.length <= 1) return fallback; // nothing to re-rank
    if (!this.withinBudget()) {
      log.warn(`otak budget exhausted (${this.opts.maxCallsPerHour}/h) — using heuristic`);
      return fallback;
    }

    const validIds = new Set(req.candidates.map((c) => c.id));

    for (const p of this.providers) {
      const h = this.health.get(p.name);
      if (h && !h.ok && Date.now() - h.checkedAt < 10 * 60_000) continue; // demoted

      this.callTimes.push(Date.now());
      let reply: ProviderReply;
      try {
        reply = await p.decide(req, this.opts.timeoutMs);
      } catch (err) {
        log.warn(`provider ${p.name} failed, falling through: ${(err as Error).message}`);
        this.health.set(p.name, {
          name: p.name,
          ok: false,
          detail: (err as Error).message,
          checkedAt: Date.now(),
        });
        continue;
      }

      // ---- GUARDRAIL -------------------------------------------------------
      // The model may only pick an id we offered. Anything else is discarded,
      // never executed. This is what stops a hallucinated action from reaching
      // the game.
      if (reply.chosenId !== null && !validIds.has(reply.chosenId)) {
        log.warn(
          `provider ${p.name} returned unknown id "${reply.chosenId}" — rejected, using heuristic`,
        );
        return fallback;
      }

      const minConf = this.opts.minConfidence ?? 0;
      if (reply.chosenId !== null && reply.confidence < minConf) {
        log.debug(
          `provider ${p.name} confidence ${reply.confidence} < ${minConf} — using heuristic`,
        );
        return fallback;
      }

      this.health.set(p.name, {
        name: p.name,
        ok: true,
        detail: 'decided',
        checkedAt: Date.now(),
      });

      return {
        chosenId: reply.chosenId,
        confidence: reply.confidence,
        reasoning: reply.reasoning || '(no reasoning given)',
        source: 'llm',
        provider: p.name,
      };
    }

    log.warn('all otak providers unavailable — using heuristic');
    return fallback;
  }
}

export * from './types.js';
