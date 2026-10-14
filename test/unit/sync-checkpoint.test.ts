import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manifest } from '../../src/storage/manifest.js';
import { loadMatcher } from '../../src/project/scan.js';
import type { MemoryContext } from '../../src/shared/context.js';

const state = vi.hoisted(() => ({ calls: [] as string[], inFlight: 0, peak: 0, embedCalls: [] as Array<{ batchSize: number; concurrency: number }> }));

vi.mock('../../src/indexing/embed-pending.js', () => ({
  embedPending: async (_ctx: unknown, opts: { batchSize: number; concurrency: number }) => {
    state.embedCalls.push(opts);
    return { embedded: 0, status: 'ok', error: '' };
  },
}));

vi.mock('../../src/indexing/file-indexer.js', () => ({
  FileIndexer: class {
    semantic = 'unknown';
    semanticError = '';
    setKnownPaths(): void {}
    async index(input: { relativePath: string }): Promise<void> {
      state.inFlight++;
      state.peak = Math.max(state.peak, state.inFlight);
      await new Promise((r) => setTimeout(r, 5));
      state.calls.push(input.relativePath);
      state.inFlight--;
    }
  },
}));

const { syncProject } = await import('../../src/indexing/sync.js');

describe('syncProject parallel indexing with checkpoint', () => {
  let root: string;
  let manifest: Manifest;

  const makeCtx = (concurrency?: number): MemoryContext => ({
    root,
    config: { maxFileSize: 1024 * 1024, indexConcurrency: concurrency } as MemoryContext['config'],
    manifest,
    typesense: { ensureCollection: async () => {}, deleteByFile: async () => {} } as unknown as MemoryContext['typesense'],
    qdrant: { deleteByFile: async () => {} } as unknown as MemoryContext['qdrant'],
    embeddings: { health: async () => ({ ok: false }) } as unknown as MemoryContext['embeddings'],
    matcher: loadMatcher(root),
    logger: { warn: () => {} } as unknown as MemoryContext['logger'],
    close: () => {},
  } as unknown as MemoryContext);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sync-checkpoint-'));
    mkdirSync(join(root, '.memory'), { recursive: true });
    for (let i = 0; i < 45; i++) writeFileSync(join(root, `f${String(i).padStart(2, '0')}.ts`), `file ${i}\n`);
    manifest = new Manifest(join(root, '.memory', 'index.db'));
    state.calls = [];
    state.inFlight = 0;
    state.peak = 0;
    state.embedCalls = [];
  });

  afterEach(() => {
    manifest.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('indexes all files with at most 20 in flight and clears the checkpoint', async () => {
    const report = await syncProject(makeCtx());

    expect(state.calls.length).toBe(45);
    expect(state.peak).toBeLessThanOrEqual(20);
    expect(state.peak).toBeGreaterThan(1);
    expect(report.errors).toHaveLength(0);
    expect(manifest.getMeta('last_index_path')).toBe('');
  });

  it('runs the batched embedding phase once after the file pool and reports its status', async () => {
    const report = await syncProject(makeCtx(7));

    expect(state.embedCalls).toEqual([{ batchSize: 96, concurrency: 2 }]);
    expect(report.semantic).toBe('ok');
    expect(report.semanticError).toBe('');
  });

  it('resumes from the stored checkpoint instead of the beginning', async () => {
    manifest.setMeta('last_index_path', 'f19.ts');

    await syncProject(makeCtx());

    expect(state.calls.length).toBe(25);
    expect(state.calls[0]).toBe('f20.ts');
    expect(state.calls.every((p) => p > 'f19.ts')).toBe(true);
    expect(manifest.getMeta('last_index_path')).toBe('');
  });

  it('respects a custom indexConcurrency from config', async () => {
    await syncProject(makeCtx(3));

    expect(state.peak).toBeLessThanOrEqual(3);
    expect(state.calls.length).toBe(45);
  });
});
