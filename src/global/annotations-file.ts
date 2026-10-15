import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from '../storage/manifest.js';
import type { Annotation } from '../shared/types.js';

export const annotationsPath = (root: string): string => join(root, '.memory', 'annotations.json');

/** Loads .memory/annotations.json into the manifest; the file wins only when it is newer. */
export function importAnnotations(root: string, manifest: Manifest): void {
  if (!existsSync(annotationsPath(root))) return;
  let items: Annotation[] = [];
  try { items = JSON.parse(readFileSync(annotationsPath(root), 'utf8')); } catch { return; }
  if (!Array.isArray(items)) return;
  for (const a of items) {
    const current = manifest.getAnnotation(a.relativePath);
    if (!current || current.updatedAt < a.updatedAt) manifest.upsertAnnotation(a);
  }
}

/** Writes all annotations to .memory/annotations.json (stable order, only when content changed). */
export function exportAnnotations(root: string, manifest: Manifest): void {
  const items = manifest.listAnnotations();
  const text = JSON.stringify(items, null, 2) + '\n';
  const exists = existsSync(annotationsPath(root));
  if (!exists && items.length === 0) return;
  if (exists && readFileSync(annotationsPath(root), 'utf8') === text) return;
  writeFileSync(annotationsPath(root), text);
}
