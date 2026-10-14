import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manifest } from '../../src/storage/manifest.js';
import type { Chunk, FileRecord } from '../../src/shared/types.js';

const file = (relativePath: string, sha256: string): FileRecord => ({
  id: `id-${relativePath}`, path: `/proj/${relativePath}`, relativePath, language: 'typescript', size: 10,
  sha256, mtimeMs: 1, gitBranch: '', gitCommit: 'c1', isTest: false, isDocumentation: false, isConfig: false,
  indexedAt: 'now', indexVersion: 1,
});

const chunk = (fileId: string, n: number): Chunk => ({
  chunkId: `${fileId}-${n}`, fileId, path: 'src/a.ts', lineStart: n, lineEnd: n + 1, symbol: `s${n}`,
  chunkType: 'function', content: `content ${n}`, contentHash: `h${n}`, language: 'typescript',
  imports: [], exports: [], relatedPaths: [],
});

describe('pending embeddings manifest', () => {
  let dir: string;
  let manifest: Manifest;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pm-pending-'));
    manifest = new Manifest(join(dir, 'index.db'));
  });

  afterEach(() => {
    manifest.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns unembedded chunks with text and file fields for the payload', () => {
    manifest.upsertFile(file('src/a.ts', 'sha-a'));
    manifest.replaceChunks('id-src/a.ts', [chunk('id-src/a.ts', 1), chunk('id-src/a.ts', 2)], new Set(['id-src/a.ts-2']));

    const pending = manifest.unembeddedChunks(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(expect.objectContaining({
      chunkId: 'id-src/a.ts-1', relativePath: 'src/a.ts', language: 'typescript', symbol: 's1',
      chunkType: 'function', lineStart: 1, lineEnd: 2, contentHash: 'h1', content: 'content 1', gitCommit: 'c1', summary: '',
    }));
  });

  it('respects the limit and skips chunks already embedded', () => {
    manifest.upsertFile(file('src/a.ts', 'sha-a'));
    manifest.replaceChunks('id-src/a.ts', [chunk('id-src/a.ts', 1), chunk('id-src/a.ts', 2), chunk('id-src/a.ts', 3)], new Set());

    expect(manifest.unembeddedChunks(2)).toHaveLength(2);
    manifest.markChunksEmbedded(['id-src/a.ts-1']);
    expect(manifest.unembeddedChunks(10).map((c) => c.chunkId)).toEqual(['id-src/a.ts-2', 'id-src/a.ts-3']);
  });

  it('marks several chunks as embedded in one call', () => {
    manifest.upsertFile(file('src/a.ts', 'sha-a'));
    manifest.replaceChunks('id-src/a.ts', [chunk('id-src/a.ts', 1), chunk('id-src/a.ts', 2)], new Set());

    manifest.markChunksEmbedded(['id-src/a.ts-1', 'id-src/a.ts-2']);
    expect(manifest.unembeddedChunks(10)).toHaveLength(0);
    expect(manifest.pathsWithUnembedded()).toHaveLength(0);
  });

  it('exposes the annotation summary only while its content hash matches the file', () => {
    manifest.upsertFile(file('src/a.ts', 'sha-a'));
    manifest.replaceChunks('id-src/a.ts', [chunk('id-src/a.ts', 1)], new Set());
    manifest.upsertAnnotation({ relativePath: 'src/a.ts', summary: 'Auth entry', role: 'module', contentHash: 'sha-a', author: 'agent', updatedAt: 'now' });
    expect(manifest.unembeddedChunks(10)[0].summary).toBe('Auth entry');

    manifest.upsertAnnotation({ relativePath: 'src/a.ts', summary: 'Old', role: 'module', contentHash: 'outdated', author: 'agent', updatedAt: 'now' });
    expect(manifest.unembeddedChunks(10)[0].summary).toBe('');
  });
});
