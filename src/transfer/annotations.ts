import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { relative } from 'node:path';
import { annotationsPath } from '../global/annotations-file.js';
import { assertAllowedPath, assertNoSymlink } from './paths.js';
import type { LogicalIndex, Row } from './sqlite.js';
import type { Annotation } from '../shared/types.js';

const annotationSchema = z.strictObject({ relativePath: z.string(), summary: z.string(), role: z.string(),
  contentHash: z.string(), author: z.string(), updatedAt: z.iso.datetime(), isStale: z.boolean().optional() });

export function annotationsOf(index: LogicalIndex): Annotation[] {
  return index.annotations.map((r) => ({ relativePath: String(r.relative_path), summary: String(r.summary), role: String(r.role),
    contentHash: String(r.content_hash), author: String(r.author), updatedAt: String(r.updated_at) }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en'));
}

export function mergeAnnotations(root: string, index: LogicalIndex, path = annotationsPath(root)): void {
  assertNoSymlink(root, relative(root, path));
  const map = new Map(index.annotations.map((r) => [String(r.relative_path), r]));
  if (existsSync(path)) {
    const items = z.array(annotationSchema).parse(JSON.parse(readFileSync(path, 'utf8')));
    for (const a of items) {
      assertAllowedPath(a.relativePath);
      const row: Row = { relative_path: a.relativePath, summary: a.summary, role: a.role, content_hash: a.contentHash,
        author: a.author, updated_at: a.updatedAt };
      const current = map.get(a.relativePath);
      if (!current || String(current.updated_at) < a.updatedAt) map.set(a.relativePath, row);
    }
  }
  index.annotations = [...map.values()];
}
