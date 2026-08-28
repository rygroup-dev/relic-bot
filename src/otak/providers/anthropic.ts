/**
 * Anthropic provider — uses the official @anthropic-ai/sdk.
 *
 * Default model is `claude-opus-5`. Effort is configurable and defaults to
 * "low": this is a high-volume, latency-sensitive advisory route where the
 * task (re-rank a short pre-validated candidate list) is simple. Raise it via
 * OTAK_ANTHROPIC_EFFORT if you want more deliberation per decision.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  OTAK_SYSTEM,
  renderRequest,
  parseReply,
  type OtakProvider,
  type OtakRequest,
  type ProviderReply,
} from '../types.js';

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export class AnthropicProvider implements OtakProvider {
  readonly name = 'anthropic' as const;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: NonNullable<AnthropicOptions['effort']>;

  constructor(opts: AnthropicOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? 'claude-opus-5';
    this.effort = opts.effort ?? 'low';
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      });
      return { ok: true, detail: `${this.model} reachable` };
    } catch (err) {
      return { ok: false, detail: describe(err) };
    }
  }

  async decide(req: OtakRequest, timeoutMs: number): Promise<ProviderReply> {
    const res = await this.client.messages.create(
      {
        model: this.model,
        // A decision is a one-line JSON object; 1024 was pure headroom.
        max_tokens: 256,
        // The instruction block is byte-identical on every call, so caching it
        // makes the repeated part ~10x cheaper. The volatile candidate list is
        // in the user turn, after the breakpoint, so it never invalidates.
        system: [
          {
            type: 'text' as const,
            text: OTAK_SYSTEM,
            cache_control: { type: 'ephemeral' as const },
          },
        ],
        output_config: { effort: this.effort },
        messages: [{ role: 'user', content: renderRequest(req) }],
      },
      { timeout: timeoutMs },
    );

    const u = res.usage as { cache_read_input_tokens?: number } | undefined;
    if (u?.cache_read_input_tokens !== undefined) {
      lastCacheRead = u.cache_read_input_tokens;
    }

    if (res.stop_reason === 'refusal') {
      throw new Error(`anthropic refused: ${res.stop_details?.category ?? 'unknown'}`);
    }

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (!text) throw new Error('anthropic returned no text block');
    return parseReply(text);
  }
}

/** Last observed cache-read token count, surfaced in Telegram health. */
let lastCacheRead = 0;
export function otakCacheReadTokens(): number {
  return lastCacheRead;
}

function describe(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'invalid API key (401)';
  if (err instanceof Anthropic.RateLimitError) return 'rate limited (429)';
  if (err instanceof Anthropic.APIError) return `api error ${err.status}: ${err.message}`;
  return (err as Error)?.message ?? String(err);
}
