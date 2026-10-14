import type { EmbeddingProvider } from './provider.js';
import { redact } from '../security/redact.js';

export interface OpenAIOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  dimensions: number;
  batchSize?: number;
  timeoutMs?: number;
}

/**
 * OpenAI-compatible `/embeddings` client. Works with OpenAI, Ollama (`/v1`),
 * LM Studio, vLLM and any server implementing the same contract.
 */
export class OpenAICompatibleProvider implements EmbeddingProvider {
  private dims: number;

  constructor(private readonly opts: OpenAIOptions) {
    this.dims = opts.dimensions;
  }

  dimensions = () => this.dims;

  embed = async (text: string) => (await this.embedBatch([text]))[0];

  async embedBatch(texts: string[]): Promise<number[][]> {
    const size = this.opts.batchSize ?? 32;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += size) {
      out.push(...(await this.request(texts.slice(i, i + size))));
    }
    return out;
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const [v] = await this.request(['health check']);
      this.dims = v.length;
      return { ok: true, detail: `${this.opts.model} (${v.length} dims)` };
    } catch (e) {
      return { ok: false, detail: redact((e as Error).message) };
    }
  }

  private async request(input: string[]): Promise<number[][]> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.opts.model, input }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`embedding endpoint returned HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ embedding: number[]; index: number }> };
    if (!json.data || json.data.length !== input.length) throw new Error('unexpected embedding response');
    return [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
