import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Generation } from '../storage/generation.js';
import type { Annotation } from '../shared/types.js';
import { canonicalJson, type DumpManifest } from './manifest.js';
import { readIndex } from './sqlite.js';
import { logicalSummary, validateSnapshot } from './consistency.js';
import { sourceBindings } from './import-normalize.js';
import type { IdMap } from './import-rebind.js';
import type { ImportStores } from './import-stores.js';
import type { Snapshot } from './types.js';

function same(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`Staging ${label} mismatch`);
}

/** Read every persisted record before the generation can become ready. */
export async function verifyImport(generation: Generation, stores: ImportStores, expected: Snapshot,
  source: Snapshot, ids: IdMap, manifest: DumpManifest, annotations: Annotation[]): Promise<void> {
  const db = new DatabaseSync(generation.indexPath, { readOnly: true });
  let index;
  try {
    index = readIndex(db); // Includes SQLite integrity_check.
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite foreign_key_check failed');
  } finally { db.close(); }
  const vectors = await stores.qdrant.exportSnapshot();
  const lexical = await stores.typesense.exportSnapshot();
  const actual: Snapshot = { index, vectors, lexical };
  validateSnapshot(actual, generation.projectId, manifest.embedding.dimensions);
  same(JSON.parse(readFileSync(generation.annotationsPath, 'utf8')), annotations, 'annotations');
  const expectedPoints = new Map(expected.vectors.points.map((p) => [p.id, p]));
  for (const point of vectors.points) {
    const original = expectedPoints.get(point.id);
    if (!original) throw new Error(`Staging unexpected point ID: ${point.id}`);
    for (let i = 0; i < point.vector.length; i++) {
      if (Math.abs(point.vector[i] - original.vector[i]) > 1e-6) throw new Error(`Staging vector differs from export: ${point.id}`);
    }
    // Vector equality is numerical, all other fields are hashed exactly.
    point.vector = [...original.vector];
  }
  const expectedIndex = structuredClone(expected.index);
  expectedIndex.meta = expectedIndex.meta.filter((r) => !String(r.key).startsWith('import_'));
  same(logicalSummary(actual), logicalSummary({ ...expected, index: expectedIndex }), 'contents');
  same(logicalSummary(sourceBindings(actual, source, ids)),
    { counts: manifest.counts, logicalHashes: manifest.logicalHashes }, 'source logical hashes');
}
