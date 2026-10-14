import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manifest } from '../../src/storage/manifest.js';
import type { FileRecord } from '../../src/shared/types.js';

const file = (relativePath: string, sha256: string): FileRecord => ({
  id: `id-${relativePath}`, path: `/proj/${relativePath}`, relativePath, language: 'typescript', size: 10,
  sha256, mtimeMs: 1, gitBranch: '', gitCommit: '', isTest: false, isDocumentation: false, isConfig: false,
  indexedAt: new Date().toISOString(), indexVersion: 1,
});

describe('annotations manifest', () => {
  let dir: string;
  let manifest: Manifest;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pm-annotations-'));
    manifest = new Manifest(join(dir, 'index.db'));
  });

  afterEach(() => {
    manifest.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores and reads an annotation by relative path', () => {
    manifest.upsertAnnotation({ relativePath: 'src/a.ts', summary: 'Auth entry', role: 'module', contentHash: 'h1', author: 'agent', updatedAt: 'now' });
    expect(manifest.getAnnotation('src/a.ts')?.summary).toBe('Auth entry');
    expect(manifest.listAnnotations()).toHaveLength(1);
  });

  it('updates an existing annotation instead of duplicating it', () => {
    const base = { relativePath: 'src/a.ts', role: 'module', contentHash: 'h1', author: 'agent', updatedAt: 'now' };
    manifest.upsertAnnotation({ ...base, summary: 'first' });
    manifest.upsertAnnotation({ ...base, summary: 'second' });
    expect(manifest.listAnnotations()).toEqual([expect.objectContaining({ summary: 'second' })]);
  });

  it('lists files without annotation or with a stale content hash as pending', () => {
    manifest.upsertFile(file('src/a.ts', 'h1'));
    manifest.upsertFile(file('src/b.ts', 'h2'));
    manifest.upsertFile(file('src/c.ts', 'h3'));
    manifest.upsertAnnotation({ relativePath: 'src/a.ts', summary: 'ok', role: 'module', contentHash: 'h1', author: 'agent', updatedAt: 'now' });
    manifest.upsertAnnotation({ relativePath: 'src/c.ts', summary: 'old', role: 'module', contentHash: 'outdated', author: 'agent', updatedAt: 'now' });
    expect(manifest.pendingAnnotations().map((p) => p.relativePath)).toEqual(['src/b.ts', 'src/c.ts']);
  });

  it('removes the annotation together with the file', () => {
    manifest.upsertFile(file('src/a.ts', 'h1'));
    manifest.upsertAnnotation({ relativePath: 'src/a.ts', summary: 'ok', role: 'module', contentHash: 'h1', author: 'agent', updatedAt: 'now' });
    manifest.deleteFile('id-src/a.ts');
    expect(manifest.getAnnotation('src/a.ts')).toBeUndefined();
  });

  it('keeps annotations when derived state is reset for reindex', () => {
    manifest.upsertFile(file('src/a.ts', 'h1'));
    manifest.upsertAnnotation({ relativePath: 'src/a.ts', summary: 'ok', role: 'module', contentHash: 'h1', author: 'agent', updatedAt: 'now' });
    manifest.resetDerivedState();
    expect(manifest.getAnnotation('src/a.ts')?.summary).toBe('ok');
  });
});
