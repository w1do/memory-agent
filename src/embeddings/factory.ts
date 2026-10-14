import type { MemoryConfig, EnvMap } from '../project/config.js';
import { NullEmbeddingProvider, type EmbeddingProvider } from './provider.js';
import { OpenAICompatibleProvider } from './openai.js';

/**
 * Settings priority: process env > .memory/.env > config.json.
 * Without a base URL and key (or a local endpoint) semantic search is reported as unavailable.
 */
export function createEmbeddingProvider(config: MemoryConfig, env: EnvMap): EmbeddingProvider {
  const pick = (k: string) => process.env[k] || env[k] || '';
  const baseUrl = pick('EMBEDDING_BASE_URL') || config.embedding.baseUrl;
  const apiKey = pick('EMBEDDING_API_KEY');
  const model = pick('EMBEDDING_MODEL') || config.embedding.model;
  const dimensions = Number(pick('EMBEDDING_DIMENSIONS')) || config.embedding.dimensions;
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(baseUrl);
  if (!apiKey && !isLocal) {
    return new NullEmbeddingProvider('EMBEDDING_API_KEY is not set (or use a local EMBEDDING_BASE_URL)', dimensions);
  }
  return new OpenAICompatibleProvider({ baseUrl, apiKey, model, dimensions, batchSize: config.embedBatchSize ?? 96 });
}
