import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manifest } from '../../src/storage/manifest.js';
import { TypesenseStore, type TsDoc } from '../../src/storage/typesense.js';
import { toPayload } from '../../src/indexing/file-indexer.js';
import { stableId, sha256, toUuid } from '../../src/shared/hash.js';
import { ExcludeMatcher, DEFAULT_EXCLUDES } from '../../src/security/policy.js';
import { Logger } from '../../src/shared/logger.js';
import type { MemoryContext } from '../../src/shared/context.js';
import type { Chunk, FileRecord } from '../../src/shared/types.js';
import type { VectorSnapshot, LexicalSnapshot } from '../../src/transfer/types.js';
import type { EmbeddingFingerprint } from '../../src/transfer/manifest.js';
import { PROVENANCE_KEY } from '../../src/transfer/provenance.js';

export const fingerprint: EmbeddingFingerprint = { model: 'fixture-model', revision: 'sha256:immutable-weights', dimensions: 2,
  inputProcessing: 'path-newline-symbol-newline-content-v1', truncation: 'first-6000-js-code-units', normalization: 'provider-output', distance: 'Cosine' };

export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'memory-transfer-'));
  mkdirSync(join(root, '.memory'));
  mkdirSync(join(root, 'src'));
  const manifest = new Manifest(join(root, '.memory', 'index.db'));
  manifest.ensureProject('source', 'Source', root);
  manifest.setMeta(PROVENANCE_KEY, JSON.stringify(fingerprint));
  manifest.setMeta('private-credentials', 'MUST-NOT-TRANSFER');
  const config: MemoryContext['config'] = { root, projectId: 'source', projectName: 'Source', collection: 'source',
    host: '127.0.0.1', qdrantPort: 6333, typesensePort: 8108, maxFileSize: 524288,
    embedding: { baseUrl: 'http://localhost/v1', model: fingerprint.model, dimensions: 2, revision: fingerprint.revision } };
  const vectors: VectorSnapshot = { version: '1.19.0', parameters: { vectors: { size: 2, distance: 'Cosine' } }, points: [] };
  const lexical: LexicalSnapshot = { version: '30.0', schema: { name: 'source', fields: [{ name: 'content', type: 'string' }] }, documents: [] };
  let embeddingCalls = 0;
  const ctx = { root, config, manifest, matcher: new ExcludeMatcher(DEFAULT_EXCLUDES), logger: new Logger(undefined, true),
    qdrant: { exportSnapshot: async () => structuredClone(vectors) },
    typesense: { exportSnapshot: async () => structuredClone(lexical) },
    embeddings: { embed: async () => { embeddingCalls++; throw Error('Embedding forbidden'); },
      embedBatch: async () => { embeddingCalls++; throw Error('Embedding forbidden'); }, dimensions: () => 2, fingerprint: () => fingerprint },
    close: () => manifest.close(),
  } as unknown as MemoryContext;
  const addFile = (path = 'src/a.ts', embedded = true) => {
    const content = 'export const a = 1;';
    writeFileSync(join(root, path), content);
    const file: FileRecord = { id: stableId(config.projectId, path), relativePath: path, path: join(root, path),
      size: Buffer.byteLength(content), sha256: sha256(content), mtimeMs: 1, gitBranch: 'main', gitCommit: 'fixture',
      language: 'typescript', isTest: false, isDocumentation: false, isConfig: false, indexedAt: '2026-10-26T00:00:00.000Z', indexVersion: 1 };
    // Identical chunks exercise the ordinal part of the ID algorithm.
    const chunks: Chunk[] = [0, 1].map((n) => ({ chunkId: stableId(file.id, `a|${sha256(content)}`, String(n)),
      fileId: file.id, path, symbol: 'a', content, contentHash: sha256(content), chunkType: 'export', lineStart: n + 1, lineEnd: n + 1,
      language: 'typescript', imports: [], exports: ['a'], relatedPaths: [] }));
    manifest.upsertFile(file);
    manifest.replaceChunks(file.id, chunks, new Set(embedded ? chunks.map((c) => c.chunkId) : []));
    manifest.replaceStructure(file.id, [{ name: 'a', kind: 'export', lineStart: 1, lineEnd: 1, exported: true }], [], ['a']);
    const store = new TypesenseStore({ host: '127.0.0.1', port: 1, apiKey: '', collection: 'source' });
    lexical.documents.push(...store.toDocs(file, chunks, ['a'], config.projectId, ''));
    vectors.points.push(...chunks.map((c) => ({ id: toUuid(c.chunkId), vector: [0.6, 0.8], payload: toPayload(config.projectId, file, c, '') })));
    return { file, chunks };
  };
  const data = addFile();
  return { root, ctx, manifest, vectors, lexical, ...data, addFile, get embeddingCalls() { return embeddingCalls; },
    cleanup() { manifest.close(); rmSync(root, { recursive: true, force: true }); } };
}
export type Fixture = ReturnType<typeof fixture>;
