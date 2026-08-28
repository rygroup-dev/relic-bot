/**
 * Sakana "Fugu" provider.
 *
 * Endpoint and model are configurable because this API is not stable and the
 * key has failed with 401 before in another project (see hoodsniper notes).
 * The health check is therefore mandatory rather than advisory: a bad key here
 * must demote the provider rather than silently fail every decision.
 *
 * Speaks an OpenAI-compatible chat/completions shape, which is what the
 * Sakana-hosted gateways expose.
 */

import {
  OTAK_SYSTEM,
  renderRequest,
  parseReply,
  type OtakProvider,
  type OtakRequest,
  type ProviderReply,
} from '../types.js';

export interface FuguOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class FuguProvider implements OtakProvider {
  readonly name = 'fugu' as const;
  private readonly apiKey: string;
  private model: string;
  private readonly baseUrl: string;

  constructor(opts: FuguOptions) {
    this.apiKey = opts.apiKey;
    // Verified against the live /v1/models listing 2026-08-28:
    //   fugu, fugu-ultra, fugu-ultra-20260615, fugu-ultra-v1.0, fugu-ultra-v1.1
    // `fugu-ultra` is the flagship; a wrong id returns 404, not 401, so the
    // health check distinguishes "bad model" from "bad key".
    this.model = opts.model ?? 'fugu-ultra';
    this.baseUrl = (opts.baseUrl ?? 'https://api.sakana.ai/v1').replace(/\/$/, '');
  }

  /** Model ids the account can actually use, newest-looking first. */
  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`models ${res.status}`);
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id);
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const reply = await this.chat(
        'Reply with JSON {"chosenId":null,"confidence":0,"reasoning":"ok"}',
        10_000,
      );
      return { ok: reply.length > 0, detail: `${this.model} responded` };
    } catch (err) {
      const m = (err as Error).message;
      if (/401|403/.test(m)) return { ok: false, detail: `key rejected: ${m}` };

      // A 404 means the key is fine but the model id is wrong. Rather than
      // making the operator guess, ask the API what it offers and switch.
      if (/404/.test(m)) {
        try {
          const models = await this.listModels();
          const pick =
            models.find((x) => x === 'fugu-ultra') ??
            models.find((x) => x.startsWith('fugu-ultra')) ??
            models[0];
          if (pick) {
            this.model = pick;
            const retry = await this.chat(
              'Reply with JSON {"chosenId":null,"confidence":0,"reasoning":"ok"}',
              10_000,
            );
            return {
              ok: retry.length > 0,
              detail: `switched to ${pick} (available: ${models.join(', ')})`,
            };
          }
          return { ok: false, detail: `no usable model; API offers: ${models.join(', ')}` };
        } catch (e2) {
          return { ok: false, detail: `${m}; model discovery also failed: ${(e2 as Error).message}` };
        }
      }
      return { ok: false, detail: m };
    }
  }

  private async chat(userContent: string, timeoutMs: number): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: OTAK_SYSTEM },
          { role: 'user', content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`fugu ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return body.choices?.[0]?.message?.content ?? '';
  }

  async decide(req: OtakRequest, timeoutMs: number): Promise<ProviderReply> {
    const text = await this.chat(renderRequest(req), timeoutMs);
    if (!text) throw new Error('fugu returned no content');
    return parseReply(text);
  }
}
