import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { relative } from 'node:path';
import { annotationsPath } from '../global/annotations-file.js';
import { assertAllowedPath, assertNoSymlink } from './paths.js';
import type { LogicalIndex, Row } from './sqlite.js';
import type { Annotation } from '../shared/types.js';
import { redact } from '../security/redact.js';

const annotationSchema = z.strictObject({ relativePath: z.string(), summary: z.string(), role: z.string(),
  contentHash: z.string(), author: z.string(), updatedAt: z.iso.datetime(), isStale: z.boolean().optional() });

/** Check every string, including nested entities/relations/constraints, without echoing values or keys. */
function assertNoAnnotationSecrets(value: unknown, field = 'annotation'): void {
  if (typeof value === 'string' && redact(value) !== value) throw new Error(`Secret detected in ${field}; export refused`);
  if (Array.isArray(value)) for (const item of value) assertNoAnnotationSecrets(item, field);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    // Only schema field names are safe to include in diagnostics; arbitrary JSON keys can contain secrets.
    const label = ['summary', 'entities', 'relations', 'constraints', 'role', 'author', 'relativePath',
      'relative_path', 'contentHash', 'content_hash', 'updatedAt', 'updated_at'].includes(key) ? key : field;
    assertNoAnnotationSecrets(key, field);
    assertNoAnnotationSecrets(item, label);
  }
}

export function annotationsOf(index: LogicalIndex): Annotation[] {
  return index.annotations.map((r) => ({ relativePath: String(r.relative_path), summary: String(r.summary), role: String(r.role),
    contentHash: String(r.content_hash), author: String(r.author), updatedAt: String(r.updated_at) }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en'));
}

export function mergeAnnotations(root: string, index: LogicalIndex, path = annotationsPath(root)): void {
  assertNoSymlink(root, relative(root, path));
  const map = new Map(index.annotations.map((r) => [String(r.relative_path), r]));
  if (existsSync(path)) {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    assertNoAnnotationSecrets(raw);
    const items = z.array(annotationSchema).parse(raw);
    for (const a of items) {
      assertAllowedPath(a.relativePath);
      const row: Row = { relative_path: a.relativePath, summary: a.summary, role: a.role, content_hash: a.contentHash,
        author: a.author, updated_at: a.updatedAt };
      const current = map.get(a.relativePath);
      if (!current || String(current.updated_at) < a.updatedAt) map.set(a.relativePath, row);
    }
  }
  index.annotations = [...map.values()];
  assertNoAnnotationSecrets(index.annotations);
}
