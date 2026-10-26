import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { collectionName, configPath, saveConfig, type EnvMap, type MemoryConfig } from '../project/config.js';
import { indexDbPath } from '../global/paths.js';
import { sha256 } from '../shared/hash.js';
import { activeGeneration, durableJson, flushFile, generationDir, publishGeneration, type Generation } from '../storage/generation.js';
import { withMemoryLock } from '../storage/memory-lock.js';
import { checkMemoryImport } from './import-checks.js';
import { readImportSnapshot } from './import-read.js';
import { localFiles, localFilesHash, rebindSnapshot } from './import-rebind.js';
import { importStores, type StoreFactory } from './import-stores.js';
import { finishJournal, recoverImportLocked, writeJournal } from './import-journal.js';
import { annotationsOf } from './annotations.js';
import { validateSnapshot } from './consistency.js';
import { writeIndex } from './sqlite.js';
import { assertNoSymlink } from './paths.js';
import { verifyImport } from './import-verify.js';

export interface ImportOptions { env?: EnvMap; stores?: StoreFactory }
export interface ImportResult { status: 'imported' | 'already-applied'; generation: Generation }

function legacyGeneration(root: string, config: MemoryConfig): Generation {
  return { id: 'legacy', projectId: config.projectId, collection: config.collection,
    indexPath: existsSync(indexDbPath(config.projectId)) ? indexDbPath(config.projectId) : join(root, '.memory', 'index.db'),
    annotationsPath: join(root, '.memory', 'annotations.json') };
}

function unchanged(generation: Generation, dumpId: string, localHash: string): boolean {
  if (generation.dumpId !== dumpId || generation.localHash !== localHash || !existsSync(generation.indexPath)) return false;
  if (!existsSync(generation.annotationsPath) || sha256(readFileSync(generation.annotationsPath)) !== generation.annotationsHash) return false;
  const db = new DatabaseSync(generation.indexPath, { readOnly: true });
  try { return db.prepare("SELECT value FROM meta WHERE key='import_dirty'").get()?.value === '0'; }
  finally { db.close(); }
}

function assertNoPendingWriter(previous: Generation): void {
  if (!existsSync(previous.indexPath)) return;
  const db = new DatabaseSync(previous.indexPath, { readOnly: true });
  try {
    for (const row of db.prepare("SELECT value FROM meta WHERE key GLOB 'index_job:*'").all()) {
      if (['queued', 'running'].includes(JSON.parse(String(row.value)).state)) throw new Error('busy: an index job is queued or running');
    }
  } finally { db.close(); }
}

/** Imports only into isolated stores; no embedding provider or sync is constructed/called. */
export async function importMemory(root: string, name: string, recipient: MemoryConfig, options: ImportOptions = {}): Promise<ImportResult> {
  const config = { ...recipient, root, projectId: recipient.projectId || collectionName(root) };
  const env = options.env ?? {}, stores = options.stores ?? importStores(config, env);
  const manifest = await checkMemoryImport(root, name, config, env);
  return withMemoryLock(root, async () => {
    await recoverImportLocked(root, stores);
    const previous = activeGeneration(root) ?? legacyGeneration(root, config);
    assertNoPendingWriter(previous);
    const files = localFiles(root, manifest, config), localHash = localFilesHash(files);
    if (unchanged(previous, manifest.dumpId, localHash)) return { status: 'already-applied', generation: previous };
    const id = randomUUID(), dir = generationDir(root, id);
    const next: Generation = { id, projectId: config.projectId, collection: `${config.collection.slice(0, 40)}-g-${id}`,
      indexPath: join(dir, 'index.db'), annotationsPath: join(dir, 'annotations.json'), dumpId: manifest.dumpId, localHash };
    // Persist intent before either service can acquire a collection, including partial creates.
    writeJournal(root, { version: 1, phase: 'building', next, previous });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let ready = false;
    try {
      const snapshot = await readImportSnapshot(root, name, manifest, dir);
      const source = structuredClone(snapshot);
      const ids = rebindSnapshot(snapshot, manifest, config, files);
      validateSnapshot(snapshot, config.projectId, manifest.embedding.dimensions);
      writeIndex(next.indexPath, snapshot.index);
      const stale = new Set(files.filter((f) => f.status === 'stale').map((f) => f.path));
      const annotations = annotationsOf(snapshot.index).map((a) => stale.has(a.relativePath) ? { ...a, isStale: true } : a);
      writeFileSync(next.annotationsPath, JSON.stringify(annotations, null, 2) + '\n', { mode: 0o600 });
      next.annotationsHash = sha256(readFileSync(next.annotationsPath));
      durableJson(join(dir, 'id-map.json'), ids);
      durableJson(join(dir, 'file-state.json'), files);
      durableJson(join(dir, 'previous.json'), previous);
      const target = stores(next.collection);
      await target.qdrant.createFromSnapshot(snapshot.vectors.parameters);
      await target.typesense.createFromSnapshot(snapshot.lexical.schema);
      for (let i = 0; i < snapshot.vectors.points.length; i += 256) {
        await target.qdrant.upsert(snapshot.vectors.points.slice(i, i + 256).map((p) => ({ chunkId: p.payload.chunk_id, vector: p.vector, payload: p.payload })));
      }
      for (let i = 0; i < snapshot.lexical.documents.length; i += 256) await target.typesense.upsert(snapshot.lexical.documents.slice(i, i + 256));
      if (await target.qdrant.count() !== snapshot.index.chunks.length || await target.typesense.count() !== snapshot.index.chunks.length) {
        throw new Error('Staging collection counts differ from the snapshot');
      }
      await verifyImport(next, target, snapshot, source, ids, manifest, annotations);
      // Source files may change during network uploads: do not advertise an outdated comparison.
      if (localFilesHash(localFiles(root, manifest, config)) !== localHash) throw new Error('Local files changed during import; retry');
      flushFile(next.indexPath); flushFile(next.annotationsPath); flushFile(dir);
      flushFile(join(root, '.memory', 'generations'));
      if (!existsSync(configPath(root))) { assertNoSymlink(root, '.memory/config.json'); saveConfig(config); flushFile(configPath(root)); }
      writeJournal(root, { version: 1, phase: 'ready', next, previous });
      ready = true;
      publishGeneration(root, next);
      writeJournal(root, { version: 1, phase: 'published', next, previous });
      finishJournal(root);
      return { status: 'imported', generation: next };
    } catch (error) {
      if (!ready) {
        // If cleanup fails the original intent remains on disk for the next recovery.
        try { await recoverImportLocked(root, stores); } catch { /* preserve journal */ }
      }
      throw error;
    }
  });
}
