import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manifest } from '../../src/storage/manifest.js';
import { attachAnnotations } from '../../src/search/hybrid.js';
import type { FileRecord, SearchHit } from '../../src/shared/types.js';
import type { MemoryContext } from '../../src/shared/context.js';

const file = (relativePath: string, sha256: string): FileRecord => ({
  id: `id-${relativePath}`, path: `/proj/${relativePath}`, relativePath, language: 'typescript', size: 10,
  sha256, mtimeMs: 1, gitBranch: '', gitCommit: '', isTest: false, isDocumentation: false, isConfig: false,
  indexedAt: new Date().toISOString(), indexVersion: 1,
});

const hit = (path: string): SearchHit => ({
  chunkId: `c-${path}`, fileId: `id-${path}`, path, symbol: '', chunkType: 'lines', language: 'typescript',
  lineStart: 1, lineEnd: 2, score: 1, lexicalScore: 1, semanticScore: 0, indexed_at: '', content_hash: '',
  is_stale: false, git_commit: '',
});

describe('search annotations', () => {
  let dir: string;
  let manifest: Manifest;
  let ctx: MemoryContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pm-search-ann-'));
    manifest = new Manifest(join(dir, 'index.db'));
    manifest.upsertFile(file('src/auth.ts', 'hash-now'));
    manifest.upsertFile(file('src/other.ts', 'hash-other'));
    manifest.upsertAnnotation({
      relativePath: 'src/auth.ts', summary: 'Auth entry point', role: 'module',
      contentHash: 'hash-now', author: 'agent', updatedAt: new Date().toISOString(),
    });
    manifest.upsertAnnotation({
      relativePath: 'src/other.ts', summary: 'Outdated', role: 'module',
      contentHash: 'hash-old', author: 'agent', updatedAt: new Date().toISOString(),
    });
    ctx = { root: dir, manifest } as unknown as MemoryContext;
  });

  afterEach(() => {
    manifest.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('attaches an annotation whose hash matches the current file', () => {
    const hits = [hit('src/auth.ts')];
    attachAnnotations(ctx, hits);
    expect(hits[0].annotation).toBe('Auth entry point');
  });

  it('skips an annotation written for an older content hash', () => {
    const hits = [hit('src/other.ts')];
    attachAnnotations(ctx, hits);
    expect(hits[0].annotation).toBeUndefined();
  });

  it('leaves files without an annotation untouched', () => {
    manifest.upsertFile(file('src/plain.ts', 'hash-plain'));
    const hits = [hit('src/plain.ts')];
    attachAnnotations(ctx, hits);
    expect(hits[0].annotation).toBeUndefined();
  });
});
