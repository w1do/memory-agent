import { z } from 'zod';
import { sha256 } from '../shared/hash.js';

export const ARTIFACT_PATHS = [
  'index.db.zst', 'annotations.json.zst', 'qdrant/points.jsonl.zst',
  'qdrant/vectors.f32le.zst', 'typesense/documents.jsonl.zst', 'typesense/schema.json',
] as const;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const known = z.string().trim().min(1).refine((v) => !/^(unknown|mixed|unspecified)$/i.test(v));
const relativePath = z.string().min(1).refine((v) =>
  !v.includes('\\') && !v.includes('\0') && !v.includes(':') &&
  !v.split('/').some((p) => p === '' || p === '.' || p === '..'), 'Expected a portable relative path');

export const fingerprintSchema = z.strictObject({
  model: known, revision: known, dimensions: size.refine((n) => n > 0),
  inputProcessing: known, truncation: known, normalization: known,
  distance: z.enum(['Cosine', 'Dot', 'Euclid', 'Manhattan']),
});
export type EmbeddingFingerprint = z.infer<typeof fingerprintSchema>;

export const manifestBodySchema = z.strictObject({
  formatVersion: z.literal(1), appVersion: known, sqliteSchemaVersion: z.literal(1),
  idAlgorithmVersion: z.literal(1), sourceProjectId: known, createdAt: z.iso.datetime(),
  services: z.strictObject({ qdrant: known, typesense: known }),
  collections: z.strictObject({
    qdrant: z.record(z.string(), z.json()), typesense: z.record(z.string(), z.json()),
  }),
  embedding: fingerprintSchema,
  artifacts: z.array(z.strictObject({
    path: z.enum(ARTIFACT_PATHS), sha256: hash, compressedSize: size, uncompressedSize: size,
  })).length(ARTIFACT_PATHS.length).refine((a) => new Set(a.map((x) => x.path)).size === ARTIFACT_PATHS.length,
    'Each required artifact must appear exactly once'),
  files: z.array(z.strictObject({ path: relativePath, sha256: hash, size })).refine(
    (a) => new Set(a.map((x) => x.path)).size === a.length, 'Duplicate indexed file'),
  counts: z.record(z.string(), size), logicalHashes: z.record(z.string(), hash),
  idParameters: z.strictObject({
    hash: z.literal('sha256-nul-32'), file: z.literal('projectId,relativePath'),
    chunk: z.literal('fileId,key,ordinal'), point: z.literal('toUuid-v1'),
    ordinals: z.array(z.strictObject({ chunkId: known, key: known, ordinal: size })).refine(
      (a) => new Set(a.map((x) => x.chunkId)).size === a.length, 'Duplicate chunk ordinal'),
  }),
});
export type DumpManifestBody = z.infer<typeof manifestBodySchema>;
export type DumpManifest = DumpManifestBody & { dumpId: string };

/** Sorted object keys, preserved array order, and JSON numbers; reject lossy JSON values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new Error('Value cannot be represented by canonical JSON');
}

export function createDumpManifest(input: DumpManifestBody): DumpManifest {
  const body = manifestBodySchema.parse(input);
  return { ...body, dumpId: sha256(canonicalJson(body)) };
}

export function parseDumpManifest(input: unknown): DumpManifest {
  const { dumpId, ...body } = manifestBodySchema.extend({ dumpId: hash }).parse(input);
  if (sha256(canonicalJson(body)) !== dumpId) throw new Error('manifest.json: dumpId mismatch');
  return { ...body, dumpId };
}
