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
  Domain,
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

/** A decision as it happened, kept so its work can actually be judged. */
export interface DecisionRecord {
  at: number;
  domain: Domain;
  source: 'heuristic' | 'llm';
  provider?: string;
  /** What the heuristics would have picked on their own. */
  heuristicChoice: string | null;
  /** What was actually chosen. */
  chosenId: string | null;
  /** True when the model moved off the heuristic pick. */
  overrode: boolean;
  confidence: number;
  reasoning: string;
  candidateCount: number;
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
  /** Rolling window of recent decisions, newest last. */
  private history: DecisionRecord[] = [];
  private static readonly HISTORY_LIMIT = 40;
  private counts = { llm: 0, heuristic: 0, overrides: 0, rejected: 0 };

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

  /** Most recent decisions, newest first. */
  recentDecisions(limit = 10): DecisionRecord[] {
    return this.history.slice(-limit).reverse();
  }

  /**
   * How much the brain is actually contributing.
   *
   * `overrideRate` is the honest measure: if the model almost never moves off
   * the heuristic pick, it is costing tokens without changing behaviour.
   */
  stats(): {
    llm: number;
    heuristic: number;
    overrides: number;
    rejected: number;
    overrideRate: number;
  } {
    const rate = this.counts.llm === 0 ? 0 : this.counts.overrides / this.counts.llm;
    return { ...this.counts, overrideRate: rate };
  }

  private record(r: DecisionRecord): void {
    this.history.push(r);
    if (this.history.length > Otak.HISTORY_LIMIT) this.history.shift();
    if (r.source === 'llm') {
      this.counts.llm += 1;
      if (r.overrode) this.counts.overrides += 1;
    } else {
      this.counts.heuristic += 1;
    }
  }

  /** Sliding-window budget so a stuck loop cannot burn the API quota. */
  private withinBudget(): boolean {
    const cutoff = Date.now() - 3_600_000;
    this.callTimes = this.callTimes.filter((t) => t > cutoff);
    return this.callTimes.length < this.opts.maxCallsPerHour;
  }

  async decide(req: OtakRequest): Promise<OtakDecision> {
    const fallback = heuristicPick(req);

    if (!this.enabled || req.candidates.length <= 1) {
      // Nothing to re-rank, or the brain is off: still recorded, so the
      // history shows what the fleet is doing either way.
      this.record({
        at: Date.now(),
        domain: req.domain,
        source: 'heuristic',
        heuristicChoice: fallback.chosenId,
        chosenId: fallback.chosenId,
        overrode: false,
        confidence: fallback.confidence,
        reasoning: fallback.reasoning,
        candidateCount: req.candidates.length,
      });
      return fallback;
    }
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
        this.counts.rejected += 1;
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

      const overrode = reply.chosenId !== fallback.chosenId;
      this.record({
        at: Date.now(),
        domain: req.domain,
        source: 'llm',
        provider: p.name,
        heuristicChoice: fallback.chosenId,
        chosenId: reply.chosenId,
        overrode,
        confidence: reply.confidence,
        reasoning: reply.reasoning,
        candidateCount: req.candidates.length,
      });

      log.info(
        `otak/${p.name} ${req.domain}: ${overrode ? 'OVERRODE' : 'agreed with'} heuristic ` +
          `(${fallback.chosenId} -> ${reply.chosenId}) conf=${reply.confidence.toFixed(2)} — ` +
          `${reply.reasoning.slice(0, 100)}`,
      );

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
