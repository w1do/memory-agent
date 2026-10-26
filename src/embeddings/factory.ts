import type { MemoryConfig, EnvMap } from '../project/config.js';
import { NullEmbeddingProvider, type EmbeddingProvider } from './provider.js';
import { OpenAICompatibleProvider } from './openai.js';
import { effectiveFingerprint } from '../transfer/provenance.js';

/** True only for loopback hosts; a name like localhost.example.com is not local. */
function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

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
  const isLocal = isLocalUrl(baseUrl);
  if (!apiKey && !isLocal) {
    return new NullEmbeddingProvider('EMBEDDING_API_KEY is not set (or use a local EMBEDDING_BASE_URL)', dimensions);
  }
  const provider = new OpenAICompatibleProvider({ baseUrl, apiKey, model, dimensions, batchSize: config.embedBatchSize ?? 96, sendDimensions: isLocal });
  return Object.assign(provider, { fingerprint: () => effectiveFingerprint(config, env) });
}
