import type { Manifest } from '../storage/manifest.js';
import type { MemoryConfig, EnvMap } from '../project/config.js';
import { canonicalJson, fingerprintSchema, type EmbeddingFingerprint } from './manifest.js';

export const PROVENANCE_KEY = 'embedding_fingerprint';
export const INPUT_PROCESSING = 'path-newline-symbol-newline-content-v1';

/** No probing or inference from model aliases: revision must be supplied explicitly. */
export function fingerprintSettings(config: MemoryConfig, env: EnvMap = {}) {
  const pick = (key: string) => process.env[key] || env[key];
  return {
    model: pick('EMBEDDING_MODEL') || config.embedding.model,
    revision: pick('EMBEDDING_REVISION') || config.embedding.revision || 'unknown',
    dimensions: Number(pick('EMBEDDING_DIMENSIONS')) || config.embedding.dimensions,
    inputProcessing: INPUT_PROCESSING, truncation: 'first-6000-js-code-units',
    normalization: 'provider-output', distance: 'Cosine',
  };
}

export function effectiveFingerprint(config: MemoryConfig, env: EnvMap = {}): EmbeddingFingerprint | undefined {
  const parsed = fingerprintSchema.safeParse(fingerprintSettings(config, env));
  return parsed.success ? parsed.data : undefined;
}

export function recordProvenance(manifest: Manifest, fingerprint: EmbeddingFingerprint | undefined): void {
  const previous = manifest.getMeta(PROVENANCE_KEY);
  const current = fingerprint ? canonicalJson(fingerprint) : 'unknown';
  const embedded = manifest.listFiles().some((f) => manifest.chunkIds(f.id).some((c) => c.embedded));
  manifest.setMeta(PROVENANCE_KEY, previous === current || (!previous && !embedded) ? current : 'mixed');
}

export function storedFingerprint(value: string | undefined): EmbeddingFingerprint {
  try { return fingerprintSchema.parse(JSON.parse(value ?? 'null')); }
  catch { throw new Error('Unknown or mixed embedding provenance; dump refused'); }
}
