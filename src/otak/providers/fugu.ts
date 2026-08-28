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
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: FuguOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'fugu-1';
    this.baseUrl = (opts.baseUrl ?? 'https://api.sakana.ai/v1').replace(/\/$/, '');
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const reply = await this.chat('Reply with JSON {"chosenId":null,"confidence":0,"reasoning":"ok"}', 10_000);
      return { ok: reply.length > 0, detail: `${this.model} responded` };
    } catch (err) {
      const m = (err as Error).message;
      if (/401|403/.test(m)) return { ok: false, detail: `key rejected: ${m}` };
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
