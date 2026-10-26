import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanups, generationFixture } from './import-generation-fixture.js';
import { importMemory } from '../../src/transfer/import.js';
import { activeGeneration } from '../../src/storage/generation.js';
import { logicalSummary } from '../../src/transfer/consistency.js';
import { sourceBindings } from '../../src/transfer/import-normalize.js';
import { readIndex } from '../../src/transfer/sqlite.js';
import type { StoreFactory } from '../../src/transfer/import-stores.js';

afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllEnvs(); });

async function roundtripFixture() {
  const f = await generationFixture((s) => {
    s.addFile('src/b.ts');
    s.manifest.replaceStructure(s.file.id, [{ name: 'a', kind: 'export', lineStart: 1, lineEnd: 1, exported: true }], ['./b'], ['a']);
    s.manifest.replaceRelations('src/a.ts', [{ fromPath: 'src/a.ts', toPath: 'src/b.ts', kind: 'import' }]);
    s.manifest.setMeta('last_sync_at', '2026-10-26T00:00:00.000Z');
    for (const file of s.manifest.listFiles()) s.manifest.upsertAnnotation({ relativePath: file.relativePath,
      contentHash: file.sha256, summary: 'Сохранить текст\nс Unicode', role: 'module', author: 'agent', updatedAt: '2026-10-26T01:00:00.000Z' });
  });
  // Recipient has source files and the copied archive, but no existing memory/configuration.
  unlinkSync(f.legacyPath); unlinkSync(join(f.root, '.memory/annotations.json'));
  return f;
}

describe('dump → import content guarantee', () => {
  it.each(['sqlite', 'json'])('refuses a secret in annotation summary from %s without exposing its value', async (store) => {
    const secret = 'sk-' + 'FAKE'.repeat(8);
    let sourceRoot = '';
    const error = await generationFixture((source) => {
      sourceRoot = source.root;
      const annotation = { relativePath: source.file.relativePath, contentHash: source.file.sha256,
        summary: `Uses ${secret}`, role: 'module', author: 'agent', updatedAt: '2026-10-26T01:00:00.000Z' };
      if (store === 'sqlite') source.manifest.upsertAnnotation(annotation);
      else writeFileSync(join(source.root, '.memory/annotations.json'), JSON.stringify([annotation]));
    }).then(() => { throw new Error('Secret was exported'); }, (error: Error) => error);
    expect(error.message).toContain('Secret detected in summary');
    expect(error.message).not.toContain(secret);
    expect(existsSync(join(sourceRoot, 'memory/backup'))).toBe(false);
  });

  it('round-trips a clean project with duplicate chunk ordinals and all logical hashes', async () => {
    const f = await roundtripFixture();
    const source = { index: f.source.manifest.transferSnapshot(), vectors: f.source.vectors, lexical: f.source.lexical };
    expect(logicalSummary(source)).toEqual({ counts: f.dump.counts, logicalHashes: f.dump.logicalHashes });
    const { generation } = await f.apply();
    expect(generation.projectId).toBe('recipient');
    expect(f.events).toContain('read-vectors'); expect(f.events).toContain('read-documents');
    const db = new DatabaseSync(generation.indexPath, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const actual = { index: readIndex(db), ...f.remoteSnapshot(generation) };
      const restored = sourceBindings(actual, source, f.json(generation, 'id-map.json'));
      expect(logicalSummary(restored)).toEqual(logicalSummary(source));
      for (const [table, rows] of Object.entries(source.index)) expect(restored.index[table]).toHaveLength(rows.length);
      for (const point of restored.vectors.points) {
        const original = source.vectors.points.find((p) => p.id === point.id)!;
        expect(point.vector).toHaveLength(f.dump.embedding.dimensions);
        point.vector.forEach((v, i) => { expect(Number.isFinite(v)).toBe(true); expect(Math.abs(v - original.vector[i])).toBeLessThanOrEqual(1e-6); });
      }
    } finally { db.close(); }
    expect(JSON.parse(readFileSync(generation.annotationsPath, 'utf8'))).toHaveLength(2);
    expect(f.source.embeddingCalls).toBe(0);
  });

  it.each(['vector-tolerance', 'reordered'])('accepts %s after reading every persisted point', async (kind) => {
    const f = await roundtripFixture();
    const stores: StoreFactory = (collection) => {
      const target = f.stores(collection), read = target.qdrant.exportSnapshot;
      target.qdrant.exportSnapshot = async () => {
        const result = await read(); result.points.reverse();
        if (kind === 'vector-tolerance') for (const p of result.points) p.vector[0] += 0.9e-6;
        return result;
      };
      return target;
    };
    expect((await importMemory(f.root, 'backup', f.config, { stores })).status).toBe('imported');
  });

  it.each(['vector-drift', 'last-vector-drift', 'nan', 'infinity', 'dimensions', 'point-id', 'duplicate-point', 'missing-point',
    'payload', 'document-text', 'document-extra-field', 'document-id', 'duplicate-document', 'missing-document',
    'sqlite-text', 'sqlite-orphan', 'sqlite-id', 'sqlite-relation', 'sqlite-annotation', 'sqlite-integrity', 'annotation-file'])(
    'refuses persisted %s corruption before publication and removes staging', async (kind) => {
      const f = await roundtripFixture();
      const stores: StoreFactory = (collection) => {
        const target = f.stores(collection), upload = target.typesense.upsert;
        target.typesense.upsert = async (docs) => {
          await upload(docs);
          const remote = f.remotes.get(collection)!, point = remote.points[0];
          if (kind === 'vector-drift') point.vector[0] += 1.1e-6;
          if (kind === 'last-vector-drift') remote.points.at(-1)!.vector[1] += 1.1e-6;
          if (kind === 'nan') point.vector[0] = NaN;
          if (kind === 'infinity') point.vector[0] = Infinity;
          if (kind === 'dimensions') point.vector.pop();
          if (kind === 'point-id') point.chunkId = 'unknown';
          if (kind === 'duplicate-point') remote.points[1] = structuredClone(point);
          if (kind === 'missing-point') remote.points.pop();
          if (kind === 'payload') point.payload.summary = 'changed';
          if (kind === 'document-text') remote.docs[0].content = 'changed';
          if (kind === 'document-extra-field') Object.assign(remote.docs[0], { unexpected: 'changed' });
          if (kind === 'document-id') remote.docs[0].id = 'unknown';
          if (kind === 'duplicate-document') remote.docs[1] = structuredClone(remote.docs[0]);
          if (kind === 'missing-document') remote.docs.pop();
          const next = JSON.parse(readFileSync(join(f.root, '.memory/import-operation.json'), 'utf8')).next;
          if (kind === 'annotation-file') writeFileSync(next.annotationsPath, '[]');
          if (kind === 'sqlite-integrity') writeFileSync(next.indexPath, 'broken SQLite');
          else if (kind.startsWith('sqlite-')) {
            const db = new DatabaseSync(next.indexPath);
            try {
              const sql: Record<string, string> = { 'sqlite-text': "UPDATE chunks SET content='changed'",
                'sqlite-orphan': "UPDATE symbols SET file_id='orphan'", 'sqlite-id': "UPDATE files SET id='unknown'",
                'sqlite-relation': 'DELETE FROM relations', 'sqlite-annotation': "UPDATE annotations SET author='changed'" };
              db.exec(sql[kind]);
            } finally { db.close(); }
          }
        };
        return target;
      };
      await expect(importMemory(f.root, 'backup', f.config, { stores })).rejects.toThrow();
      expect(activeGeneration(f.root)).toBeUndefined();
      expect(existsSync(join(f.root, '.memory/import-operation.json'))).toBe(false);
      for (const remote of f.remotes.values()) expect(remote).toMatchObject({ qdrant: false, typesense: false });
    });
});
