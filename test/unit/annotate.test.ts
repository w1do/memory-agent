import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manifest } from '../../src/storage/manifest.js';
import { annotateFile } from '../../src/mcp/tools.js';
import type { FileRecord } from '../../src/shared/types.js';
import type { MemoryContext } from '../../src/shared/context.js';

const file = (relativePath: string, sha256: string): FileRecord => ({
  id: `id-${relativePath}`, path: `/proj/${relativePath}`, relativePath, language: 'typescript', size: 10,
  sha256, mtimeMs: 1, gitBranch: '', gitCommit: '', isTest: false, isDocumentation: false, isConfig: false,
  indexedAt: new Date().toISOString(), indexVersion: 1,
});

describe('memory_annotate', () => {
  let dir: string;
  let manifest: Manifest;
  let ctx: MemoryContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pm-annotate-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'auth.ts'), 'export const a = 1;\n');
    manifest = new Manifest(join(dir, 'index.db'));
    manifest.upsertFile(file('src/auth.ts', 'hash-ok'));
    ctx = {
      root: dir,
      manifest,
      matcher: { matches: (rel: string) => rel.startsWith('secret/') },
      logger: { info: () => undefined },
    } as unknown as MemoryContext;
  });

  afterEach(() => {
    manifest.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const input = { path: 'src/auth.ts', summary: 'Auth entry point', role: 'module' as const, content_hash: 'hash-ok' };

  it('saves an annotation for an indexed file with a matching hash', () => {
    expect(annotateFile(ctx, input)).toMatchObject({ path: 'src/auth.ts', saved: true });
    expect(manifest.getAnnotation('src/auth.ts')).toMatchObject({ summary: 'Auth entry point', author: 'agent', contentHash: 'hash-ok' });
  });

  it('refuses paths outside the project', () => {
    expect(() => annotateFile(ctx, { ...input, path: '../etc/passwd' })).toThrow();
  });

  it('refuses files that are not indexed', () => {
    expect(() => annotateFile(ctx, { ...input, path: 'src/missing.ts' })).toThrow(/not indexed/);
  });

  it('refuses a stale content hash', () => {
    expect(() => annotateFile(ctx, { ...input, content_hash: 'old' })).toThrow(/content_hash/);
    expect(manifest.getAnnotation('src/auth.ts')).toBeUndefined();
  });

  it('refuses files excluded by policy', () => {
    manifest.upsertFile(file('secret/key.ts', 'hash-ok'));
    expect(() => annotateFile(ctx, { ...input, path: 'secret/key.ts' })).toThrow(/policy/);
  });

  it('refuses summaries longer than the limit', () => {
    expect(() => annotateFile(ctx, { ...input, summary: 'x'.repeat(201) })).toThrow(/characters/);
  });

  it('refuses summaries containing secrets', () => {
    expect(() => annotateFile(ctx, { ...input, summary: 'token = abcdef123456' })).toThrow(/sensitive/);
  });
});
