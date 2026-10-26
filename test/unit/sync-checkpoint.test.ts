import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manifest } from '../../src/storage/manifest.js';
import { loadMatcher } from '../../src/project/scan.js';
import type { MemoryContext } from '../../src/shared/context.js';
import { syncProject } from '../../src/indexing/sync.js';
import { TypesenseStore } from '../../src/storage/typesense.js';

describe('syncProject checkpoint recovery', () => {
  let root: string;
  let manifest: Manifest;
  let ctx: MemoryContext;
  let calls: string[];
  let fail: string;
  let inFlight: number;
  let peak: number;
  let embed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sync-checkpoint-'));
    mkdirSync(join(root, '.memory'));
    for (let i = 0; i < 45; i++) writeFileSync(join(root, `f${String(i).padStart(2, '0')}.ts`), `export const n = ${i};\n`);
    manifest = new Manifest(join(root, '.memory', 'index.db'));
    calls = []; fail = ''; inFlight = 0; peak = 0;
    embed = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2]));
    ctx = {
      root, manifest, matcher: loadMatcher(root),
      config: { projectId: 'test', maxFileSize: 1024 * 1024 },
      typesense: {
        ensureCollection: async () => {}, deleteByFile: async () => {}, deleteChunks: async () => {},
        toDocs: TypesenseStore.prototype.toDocs,
        upsert: async (docs: Array<{ path: string }>) => {
          const path = docs[0].path;
          inFlight++; peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 2));
          inFlight--; calls.push(path);
          if (path === fail) throw new Error('index failed');
        },
      },
      qdrant: { deleteByFile: async () => {}, deleteChunks: async () => {}, ensureCollection: async () => {}, upsert: async () => {} },
      embeddings: { embedBatch: embed }, logger: { warn: () => {} }, close: () => {},
    } as unknown as MemoryContext;
  });
  afterEach(() => { manifest.close(); rmSync(root, { recursive: true, force: true }); });

  it('indexes all files with at most 20 in flight and clears the checkpoint', async () => {
    const report = await syncProject(ctx);
    expect(calls).toHaveLength(45);
    expect(peak).toBeLessThanOrEqual(20);
    expect(peak).toBeGreaterThan(1);
    expect(report.errors).toHaveLength(0);
    expect(manifest.getMeta('last_index_path')).toBe('');
  });

  it('embeds pending chunks once and does not duplicate vectors on a second sync', async () => {
    expect((await syncProject(ctx)).semantic).toBe('ok');
    expect(embed).toHaveBeenCalledTimes(1);
    expect(manifest.unembeddedChunks(100)).toHaveLength(0);
    calls = [];
    await syncProject(ctx);
    expect(calls).toEqual([]);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('separates structural mode from the run label and leaves vectors to sync', async () => {
    await syncProject(ctx, { kind: 'init', mode: 'structural' });
    expect(embed).not.toHaveBeenCalled();
    expect(manifest.pendingEmbeddings()).toBeGreaterThan(0);
    const files = manifest.counts().files;
    calls = [];
    await syncProject(ctx, { kind: 'init', mode: 'full' });
    expect(calls).toEqual([]);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(manifest.pendingEmbeddings()).toBe(0);
    expect(manifest.counts().files).toBe(files);
  });

  it('replays incomplete writes inside a batch without reindexing successful writes', async () => {
    fail = 'f21.ts';
    const failed = await syncProject(ctx);
    expect(failed.errors).toEqual([{ path: 'f21.ts', message: 'index failed' }]);
    expect(manifest.getMeta('last_index_path')).toBe('f19.ts');
    expect(manifest.counts().files).toBe(44);
    calls = []; fail = '';
    // Simulate a process stopping before a batch checkpoint was saved.
    manifest.setMeta('last_index_path', 'f19.ts');
    await syncProject(ctx);
    expect(calls).toEqual(['f21.ts']);
    expect(manifest.counts()).toMatchObject({ files: 45, errors: 0 });
    expect(manifest.getMeta('last_index_path')).toBe('');
  });

  it('includes new and changed paths before the stored cursor', async () => {
    await syncProject(ctx);
    calls = [];
    writeFileSync(join(root, 'f00.ts'), 'export const changed = 12345;\n');
    writeFileSync(join(root, 'a.ts'), 'export const added = 1;\n');
    manifest.setMeta('last_index_path', 'f19.ts');
    await syncProject(ctx);
    expect(calls.sort()).toEqual(['a.ts', 'f00.ts']);
    expect(manifest.counts().files).toBe(46);
  });

  it('retries a recorded error even when stat and hash match the manifest', async () => {
    await syncProject(ctx);
    calls = [];
    manifest.recordError('f00.ts', 'unfinished derived write');
    manifest.setMeta('last_index_path', 'f19.ts');
    await syncProject(ctx);
    expect(calls).toEqual(['f00.ts']);
    expect(manifest.errors()).toEqual([]);
  });

  it('respects a custom indexConcurrency', async () => {
    ctx.config.indexConcurrency = 3;
    await syncProject(ctx);
    expect(peak).toBeLessThanOrEqual(3);
    expect(calls).toHaveLength(45);
  });
});
