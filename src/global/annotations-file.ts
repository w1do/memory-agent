import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from '../storage/manifest.js';
import type { Annotation } from '../shared/types.js';
import { withMemoryLockSync } from '../storage/memory-lock.js';
import { activeGeneration, assertCurrentGeneration } from '../storage/generation.js';

export const annotationsPath = (root: string, manifest?: Manifest): string => manifest
  ? manifest.annotationsFile ?? join(root, '.memory', 'annotations.json')
  : activeGeneration(root)?.annotationsPath ?? join(root, '.memory', 'annotations.json');

/** Loads .memory/annotations.json into the manifest; the file wins only when it is newer. */
export function importAnnotations(root: string, manifest: Manifest): void {
  const path = annotationsPath(root, manifest);
  if (!existsSync(path)) return;
  let items: Annotation[] = [];
  try { items = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
  if (!Array.isArray(items)) return;
  const changed = items.filter((a) => {
    const current = manifest.getAnnotation(a.relativePath);
    return !current || current.updatedAt < a.updatedAt;
  });
  if (changed.length) withMemoryLockSync(root, () => {
    assertCurrentGeneration(root, manifest.generationId);
    for (const a of changed) manifest.upsertAnnotation(a);
  });
}

/** Writes all annotations to .memory/annotations.json (stable order, only when content changed). */
export function exportAnnotations(root: string, manifest: Manifest): void {
  if (activeGeneration(root)?.id !== manifest.generationId) return;
  const path = annotationsPath(root, manifest);
  const items = manifest.listAnnotations();
  const text = JSON.stringify(items, null, 2) + '\n';
  const exists = existsSync(path);
  if (!exists && items.length === 0) return;
  if (exists && readFileSync(path, 'utf8') === text) return;
  withMemoryLockSync(root, () => {
    if (activeGeneration(root)?.id === manifest.generationId) writeFileSync(path, text);
  });
}
