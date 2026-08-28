/**
 * OpenAI provider (Chat Completions with JSON object response format).
 * Raw HTTP is used here deliberately: this is not Claude code, and adding a
 * second vendor SDK for one endpoint is not worth the dependency weight.
 */

import {
  OTAK_SYSTEM,
  renderRequest,
  parseReply,
  type OtakProvider,
  type OtakRequest,
  type ProviderReply,
} from '../types.js';

export interface OpenAIOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class OpenAIProvider implements OtakProvider {
  readonly name = 'openai' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: OpenAIOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'gpt-4o-mini';
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, detail: `models list ${res.status}` };
      return { ok: true, detail: `${this.model} key accepted` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async decide(req: OtakRequest, timeoutMs: number): Promise<ProviderReply> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: OTAK_SYSTEM },
          { role: 'user', content: renderRequest(req) },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error('openai returned no content');
    return parseReply(text);
  }
}
