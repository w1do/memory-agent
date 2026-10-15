import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manifest } from '../../src/storage/manifest.js';
import { annotationsPath, exportAnnotations, importAnnotations } from '../../src/global/annotations-file.js';

let root: string;
const note = { relativePath: 'a.ts', summary: 's', role: 'module', contentHash: 'h', author: 'agent', updatedAt: '2026-01-01T00:00:00.000Z' };

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pm-ann-')); mkdirSync(join(root, '.memory')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('annotations.json', () => {
  it('does not create the file when there are no annotations', () => {
    const m = new Manifest(join(root, 'x.db'));
    exportAnnotations(root, m); m.close();
    expect(existsSync(annotationsPath(root))).toBe(false);
  });

  it('round-trips annotations into a fresh manifest', () => {
    const a = new Manifest(join(root, 'a.db'));
    a.upsertAnnotation(note); exportAnnotations(root, a); a.close();
    expect(JSON.parse(readFileSync(annotationsPath(root), 'utf8'))).toHaveLength(1);
    const b = new Manifest(join(root, 'b.db'));
    importAnnotations(root, b);
    expect(b.getAnnotation('a.ts')?.summary).toBe('s');
    b.close();
  });
});
