import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import { fixture, type Fixture } from './transfer-fixture.js';
import { dumpMemory } from '../../src/transfer/dump.js';
import { importMemory } from '../../src/transfer/import.js';
import type { ImportStores, StoreFactory } from '../../src/transfer/import-stores.js';
import { Manifest } from '../../src/storage/manifest.js';
import { activeGeneration, type Generation } from '../../src/storage/generation.js';
import { toUuid } from '../../src/shared/hash.js';
import type { QdrantPoint } from '../../src/storage/qdrant.js';
import type { TsDoc } from '../../src/storage/typesense.js';

export const cleanups: Array<() => void> = [];
export interface Remote { points: QdrantPoint[]; docs: TsDoc[]; qdrant: boolean; typesense: boolean }

/** Fake only the external services. SQLite, dump files, locks and pointer I/O are real. */
export async function generationFixture(prepare?: (source: Fixture) => void) {
  const source = fixture();
  const root = mkdtempSync(join(tmpdir(), 'memory-import-'));
  cleanups.push(() => { source.cleanup(); rmSync(root, { recursive: true, force: true }); });
  vi.stubEnv('PROJECT_MEMORY_HOME', join(root, '.global'));
  prepare?.(source);
  const dump = await dumpMemory(source.ctx, 'backup');
  mkdirSync(join(root, 'memory'));
  cpSync(join(source.root, 'memory/backup'), join(root, 'memory/backup'), { recursive: true });
  cpSync(join(source.root, 'src'), join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.memory'));
  const legacyPath = join(root, '.memory/index.db');
  const legacy = new Manifest(legacyPath);
  legacy.ensureProject('recipient', 'Recipient', root);
  legacy.setMeta('legacy', 'keep for rollback');
  legacy.close();
  writeFileSync(join(root, '.memory/annotations.json'), '[]\n');
  const config = { ...source.ctx.config, root, projectId: 'recipient', projectName: 'Recipient', collection: 'recipient-local' };
  const remotes = new Map<string, Remote>();
  const events: string[] = [];
  let fault = '';
  let onUpload: (() => Promise<void>) | undefined;
  const stores: StoreFactory = (collection): ImportStores => {
    let remote = remotes.get(collection);
    if (!remote) { remote = { points: [], docs: [], qdrant: false, typesense: false }; remotes.set(collection, remote); }
    const r = remote;
    const event = (step: string) => { events.push(step); if (fault === step) throw new Error(`service failure: ${step}`); };
    return {
      qdrant: {
        createFromSnapshot: async () => { event('create-qdrant'); if (r.qdrant) throw new Error('duplicate collection'); r.qdrant = true; },
        upsert: async (points) => { event('upload-vectors'); await onUpload?.(); r.points.push(...structuredClone(points)); },
        count: async () => { event('count-qdrant'); return r.points.length + (fault === 'bad-count' ? 1 : 0); },
        exportSnapshot: async () => { event('read-vectors'); return structuredClone({ ...source.vectors,
          points: r.points.map((p) => ({ id: toUuid(p.chunkId), vector: p.vector, payload: p.payload })) }); },
        dropCollection: async () => { event('drop-qdrant'); r.qdrant = false; r.points = []; },
      },
      typesense: {
        createFromSnapshot: async () => { event('create-typesense'); if (r.typesense) throw new Error('duplicate collection'); r.typesense = true; },
        upsert: async (docs) => { event('upload-documents'); r.docs.push(...structuredClone(docs)); },
        count: async () => { event('count-typesense'); return r.docs.length; },
        exportSnapshot: async () => { event('read-documents'); return structuredClone({ ...source.lexical, documents: r.docs }); },
        dropCollection: async () => { event('drop-typesense'); r.typesense = false; r.docs = []; },
      },
    };
  };
  const apply = () => importMemory(root, 'backup', config, { stores });
  const open = (generation = activeGeneration(root)!): Manifest => {
    const manifest = new Manifest(generation.indexPath, generation);
    cleanups.unshift(() => manifest.close());
    return manifest;
  };
  const json = (generation: Generation, name: string) => JSON.parse(readFileSync(join(root, '.memory/generations', generation.id, name), 'utf8'));
  const remoteSnapshot = (generation: Generation) => {
    const remote = remotes.get(generation.collection)!;
    return { vectors: { ...source.vectors, points: remote.points.map((p) => ({ id: toUuid(p.chunkId), vector: p.vector, payload: p.payload })) },
      lexical: { ...source.lexical, documents: remote.docs } };
  };
  return { root, source, config, dump, stores, remotes, events, apply, open, json, remoteSnapshot, legacyPath,
    setFault(value: string) { fault = value; }, onUpload(callback: () => Promise<void>) { onUpload = callback; } };
}
export type GenerationFixture = Awaited<ReturnType<typeof generationFixture>>;
