import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manifest } from '../../src/storage/manifest.js';
import { embedPending } from '../../src/indexing/embed-pending.js';
import type { MemoryContext } from '../../src/shared/context.js';
import type { Chunk, FileRecord } from '../../src/shared/types.js';

interface Fake { inputs: number[]; inFlight: number; peak: number; fail: boolean }

const makeCtx = (manifest: Manifest, state: Fake): MemoryContext => ({
  root: '/proj',
  config: { projectId: 'p' } as MemoryContext['config'],
  manifest,
  embeddings: {
    embedBatch: async (texts: string[]) => {
      state.inFlight++;
      state.peak = Math.max(state.peak, state.inFlight);
      await new Promise((r) => setTimeout(r, 5));
      state.inFlight--;
      if (state.fail) throw new Error('boom key sk-abcdefghijklmnopqrstuvwx');
      state.inputs.push(texts.length);
      return texts.map(() => [0.1, 0.2]);
    },
  } as unknown as MemoryContext['embeddings'],
  qdrant: { ensureCollection: async () => {}, upsert: async () => {} } as unknown as MemoryContext['qdrant'],
  logger: { warn: () => {} } as unknown as MemoryContext['logger'],
} as unknown as MemoryContext);

const file = (n: number): FileRecord => ({
  id: `f${n}`, path: `/proj/src/f${n}.ts`, relativePath: `src/f${n}.ts`, language: 'typescript', size: 10,
  sha256: `sha${n}`, mtimeMs: 1, gitBranch: '', gitCommit: 'c1', isTest: false, isDocumentation: false, isConfig: false,
  indexedAt: 'now', indexVersion: 1,
});

const chunks = (fileId: string, n: number): Chunk[] => Array.from({ length: n }, (_, i) => ({
  chunkId: `${fileId}-${i}`, fileId, path: 'src/x.ts', lineStart: i + 1, lineEnd: i + 2, symbol: `s${i}`,
  chunkType: 'function', content: `content ${i}`, contentHash: `h${i}`, language: 'typescript',
  imports: [], exports: [], relatedPaths: [],
}) as unknown as Chunk);

describe('embedPending cross-file batching', () => {
  let dir: string;
  let manifest: Manifest;
  let state: Fake;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'embed-pending-'));
    manifest = new Manifest(join(dir, 'index.db'));
    state = { inputs: [], inFlight: 0, peak: 0, fail: false };
    for (let n = 0; n < 5; n++) {
      manifest.upsertFile(file(n));
      manifest.replaceChunks(`f${n}`, chunks(`f${n}`, 50), new Set());
    }
  });

  afterEach(() => {
    manifest.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('embeds 250 chunks from several files in batches of at most 96', async () => {
    const result = await embedPending(makeCtx(manifest, state), { batchSize: 96, concurrency: 2 });

    expect(result).toEqual({ embedded: 250, status: 'ok', error: '' });
    expect(state.inputs.reduce((a, b) => a + b, 0)).toBe(250);
    expect(state.inputs).toHaveLength(3);
    expect(Math.max(...state.inputs)).toBeLessThanOrEqual(96);
    expect(manifest.unembeddedChunks(1000)).toHaveLength(0);
  });

  it('keeps at most embedConcurrency requests in flight', async () => {
    await embedPending(makeCtx(manifest, state), { batchSize: 10, concurrency: 2 });

    expect(state.peak).toBeLessThanOrEqual(2);
    expect(state.peak).toBeGreaterThan(1);
  });

  it('stays unavailable with pending chunks on failure and embeds them on the next run', async () => {
    state.fail = true;
    const failed = await embedPending(makeCtx(manifest, state), { batchSize: 96, concurrency: 2 });

    expect(failed.status).toBe('unavailable');
    expect(failed.error).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(manifest.unembeddedChunks(1000)).toHaveLength(250);

    state.fail = false;
    const retried = await embedPending(makeCtx(manifest, state), { batchSize: 96, concurrency: 2 });

    expect(retried).toEqual({ embedded: 250, status: 'ok', error: '' });
    expect(manifest.unembeddedChunks(1000)).toHaveLength(0);
  });
});
