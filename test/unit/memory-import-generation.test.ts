import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generationFixture, cleanups } from './import-generation-fixture.js';
import { recoveryScenarios } from './import-generation-recovery.js';
import { readerScenarios } from './import-generation-readers.js';
import { validationScenarios } from './import-generation-validation.js';
import { stableId, toUuid } from '../../src/shared/hash.js';
import { activeGeneration } from '../../src/storage/generation.js';
import { checkFreshness } from '../../src/search/freshness.js';
import { attachAnnotations } from '../../src/search/hybrid.js';
import { importMemory } from '../../src/transfer/import.js';
import { collectionName } from '../../src/project/config.js';
import type { MemoryContext } from '../../src/shared/context.js';
import type { SearchHit } from '../../src/shared/types.js';

// Context wiring is exercised without accessing any real project/global env files.
vi.mock('../../src/project/config.js', async (original) => ({ ...await original<object>(), readEnvFile: () => ({}) }));
vi.mock('../../src/global/shared-mode.js', () => ({ isLegacyProject: () => true }));
vi.mock('node:fs', async (original) => ({ ...await original<object>() }));
beforeEach(() => { for (const key of ['MODEL', 'REVISION', 'DIMENSIONS']) vi.stubEnv(`EMBEDDING_${key}`, ''); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllEnvs();
});

describe('memory import generations (M4)', () => {
  it('rebinds every ID and reference, preserves recipient identity and transfers vectors without embedding', async () => {
    const f = await generationFixture((s) => {
      s.addFile('src/b.ts');
      s.manifest.replaceRelations('src/a.ts', [{ fromPath: 'src/a.ts', toPath: 'src/b.ts', kind: 'import' }]);
    });
    const before = readFileSync(f.legacyPath), oldVectors = structuredClone(f.source.vectors);
    const { generation: g } = await f.apply(), manifest = f.open(g), map = f.json(g, 'id-map.json');
    expect(g.projectId).toBe('recipient'); expect(manifest.getMeta('import_source_project_id')).toBe('source');
    const index = manifest.transferSnapshot(), remote = f.remoteSnapshot(g);
    expect(index.projects[0]).toMatchObject({ id: 'recipient', root: f.root, name: 'Recipient' });
    expect(map).toMatchObject({ version: 1, projects: { source: 'recipient' } });
    expect(Object.keys(map.files)).toHaveLength(2); expect(Object.keys(map.chunks)).toHaveLength(4); expect(Object.keys(map.points)).toHaveLength(4);
    for (const file of index.files) {
      expect(file.id).toBe(stableId('recipient', String(file.relative_path))); expect(file.path).toBe(join(f.root, String(file.relative_path)));
    }
    for (const table of ['symbols', 'imports', 'exports', 'chunks'] as const) {
      for (const row of index[table]) expect(index.files.some((file) => file.id === row.file_id)).toBe(true);
    }
    for (const params of f.dump.idParameters.ordinals) {
      const old = f.source.manifest.transferSnapshot().chunks.find((c) => c.chunk_id === params.chunkId)!;
      expect(map.chunks[params.chunkId]).toBe(stableId(map.files[String(old.file_id)], params.key, String(params.ordinal)));
      expect(map.points[toUuid(params.chunkId)]).toBe(toUuid(map.chunks[params.chunkId]));
    }
    for (const point of oldVectors.points) {
      const moved = remote.vectors.points.find((p) => p.id === map.points[point.id])!;
      expect(moved.vector).toEqual(point.vector.map(Math.fround));
      expect(moved.payload).toEqual({ ...point.payload, project_id: 'recipient', file_id: map.files[point.payload.file_id], chunk_id: map.chunks[point.payload.chunk_id] });
    }
    expect(remote.lexical.documents.map((d) => d.id).sort()).toEqual(index.chunks.map((c) => c.chunk_id).sort());
    for (const doc of f.source.lexical.documents) {
      expect(remote.lexical.documents.find((d) => d.id === map.chunks[doc.id])).toEqual({ ...doc,
        id: map.chunks[doc.id], chunk_id: map.chunks[doc.chunk_id], file_id: map.files[doc.file_id], project_id: 'recipient' });
    }
    expect(index.relations).toEqual([{ from_path: 'src/a.ts', to_path: 'src/b.ts', kind: 'import' }]);
    expect(readFileSync(f.legacyPath)).toEqual(before); expect(f.source.embeddingCalls).toBe(0);
    expect(manifest.lastRuns()).toEqual([]); expect(existsSync(join(f.root, '.memory/import-operation.json'))).toBe(false);
  });
  it('assigns identity from recipient root if it has no projectId', async () => {
    const f = await generationFixture();
    unlinkSync(f.legacyPath); unlinkSync(join(f.root, '.memory/annotations.json'));
    const { generation } = await importMemory(f.root, 'backup', { ...f.config, projectId: '' }, { stores: f.stores });
    expect(generation.projectId).toBe(collectionName(f.root));
    expect(f.open(generation).listFiles()[0].id).toBe(stableId(collectionName(f.root), 'src/a.ts'));
  });
  it('uses SHA-256, local mtime, stale annotations and unindexed extras without sync', async () => {
    const f = await generationFixture((s) => {
      s.addFile('src/b.ts'); s.addFile('src/c.ts');
      for (const file of s.manifest.listFiles()) s.manifest.upsertAnnotation({ relativePath: file.relativePath,
        contentHash: file.sha256, summary: 'kept snapshot', role: 'module', author: 'agent', updatedAt: '2026-10-26T01:00:00.000Z' });
    });
    const a = join(f.root, 'src/a.ts'), b = join(f.root, 'src/b.ts');
    utimesSync(a, 12345, 12345); writeFileSync(b, 'export const a = 2;'); utimesSync(b, 0.001, 0.001);
    unlinkSync(join(f.root, 'src/c.ts')); writeFileSync(join(f.root, 'src/extra.ts'), 'extra');
    const { generation: g } = await f.apply(), manifest = f.open(g);
    expect(manifest.getFile('src/a.ts')).toMatchObject({ mtimeMs: 12345000 });
    for (const path of ['src/b.ts', 'src/c.ts']) {
      expect(manifest.getFile(path)).toMatchObject({ status: 'stale', mtimeMs: -1 });
      expect(manifest.getAnnotation(path)).toMatchObject({ isStale: true, summary: 'kept snapshot' });
    }
    expect(manifest.getAnnotation('src/a.ts')?.isStale).toBeUndefined();
    expect(manifest.pendingAnnotations().map((a) => a.relativePath)).toEqual(['src/b.ts', 'src/c.ts']);
    expect(manifest.getFile('src/extra.ts')).toBeUndefined();
    expect(f.json(g, 'file-state.json')).toContainEqual(expect.objectContaining({ path: 'src/extra.ts', status: 'unindexed' }));
    const ctx = { ...f.source.ctx, root: f.root, config: f.config, manifest } as MemoryContext;
    const fresh = checkFreshness(ctx); expect([...fresh.stale].sort()).toEqual(['src/b.ts', 'src/c.ts']); expect(fresh.added).toEqual(['src/extra.ts']);
    const hits = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((path) => ({ path }) as SearchHit);
    attachAnnotations(ctx, hits); expect(hits.map((h) => h.annotation)).toEqual(['kept snapshot', undefined, undefined]);
    expect(manifest.lastRuns()).toEqual([]); expect(f.source.embeddingCalls).toBe(0);
  });
  it('reuses unchanged dumpId, replaces locally modified memory and keeps both generations', async () => {
    const f = await generationFixture(); const first = await f.apply(); const events = f.events.length;
    expect(await f.apply()).toEqual({ ...first, status: 'already-applied' }); expect(f.events).toHaveLength(events);
    const manifest = f.open(first.generation); manifest.setMeta('local-change', 'changed');
    const second = await f.apply(); expect(second.status).toBe('imported'); expect(second.generation.id).not.toBe(first.generation.id);
    expect(existsSync(first.generation.indexPath)).toBe(true); expect(f.remotes.get(first.generation.collection)?.qdrant).toBe(true);
    expect(f.open(second.generation).getMeta('local-change')).toBeUndefined();
    expect(f.remotes.get(second.generation.collection)?.points).toHaveLength(2);
    expect(readdirSync(join(f.root, '.memory/generations'))).toHaveLength(2);
    expect(activeGeneration(f.root)).toEqual(second.generation);
  });
  it('reimports after working-tree or annotation-file changes', async () => {
    const f = await generationFixture(); const first = await f.apply();
    writeFileSync(first.generation.annotationsPath, '[ ]\n');
    const second = await f.apply(); expect(second.status).toBe('imported');
    writeFileSync(join(f.root, 'src/a.ts'), 'local edit');
    const third = await f.apply(); expect(third.status).toBe('imported'); expect(f.open(third.generation).getFile('src/a.ts')?.status).toBe('stale');
  });
  recoveryScenarios();
  readerScenarios();
  validationScenarios();
});
