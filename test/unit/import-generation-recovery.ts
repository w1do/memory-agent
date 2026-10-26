import { expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { generationFixture } from './import-generation-fixture.js';
import * as generation from '../../src/storage/generation.js';
import * as journal from '../../src/transfer/import-journal.js';

export function recoveryScenarios() {
  it.each(['create-qdrant', 'create-typesense', 'upload-vectors', 'upload-documents', 'count-qdrant', 'bad-count'])(
    'cleans staging after %s failure and leaves the old generation intact', async (step) => {
      const f = await generationFixture(); const first = await f.apply();
      f.open(first.generation).setMeta('local-change', '1'); f.setFault(step);
      await expect(f.apply()).rejects.toThrow();
      expect(generation.activeGeneration(f.root)).toEqual(first.generation);
      expect(existsSync(first.generation.indexPath)).toBe(true);
      for (const [name, remote] of f.remotes) if (name !== first.generation.collection) expect(remote).toMatchObject({ qdrant: false, typesense: false });
      expect(existsSync(journal.journalPath(f.root))).toBe(false);
      f.setFault(''); expect((await f.apply()).status).toBe('imported');
    });
  it('keeps a retryable journal if interrupted staging cleanup only deleted one service', async () => {
    const f = await generationFixture(); const first = await f.apply();
    const id = randomUUID(), dir = generation.generationDir(f.root, id);
    const next = { ...first.generation, id, collection: `staging-${id}`, indexPath: join(dir, 'index.db'), annotationsPath: join(dir, 'annotations.json') };
    journal.writeJournal(f.root, { version: 1, phase: 'building', previous: first.generation, next });
    mkdirSync(dir); await f.stores(next.collection).qdrant.createFromSnapshot({}); await f.stores(next.collection).typesense.createFromSnapshot({});
    f.setFault('drop-typesense'); await expect(journal.recoverMemoryImport(f.root, f.stores)).rejects.toThrow('drop-typesense');
    expect(existsSync(journal.journalPath(f.root))).toBe(true); expect(existsSync(dir)).toBe(true);
    f.setFault(''); await journal.recoverMemoryImport(f.root, f.stores);
    expect(existsSync(dir)).toBe(false); expect(existsSync(journal.journalPath(f.root))).toBe(false);
    expect(generation.activeGeneration(f.root)).toEqual(first.generation);
  });
  it('finishes a durable ready journal after failure before pointer rename', async () => {
    const f = await generationFixture(); const first = await f.apply(); f.open(first.generation).setMeta('edited', '1');
    const rename = fs.renameSync;
    const publish = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === generation.pointerPath(f.root)) throw new Error('rename interrupted');
      return rename(from, to);
    });
    await expect(f.apply()).rejects.toThrow('rename interrupted'); publish.mockRestore();
    expect(generation.activeGeneration(f.root)).toEqual(first.generation);
    const pending = JSON.parse(readFileSync(journal.journalPath(f.root), 'utf8'));
    expect(pending.phase).toBe('ready'); await journal.recoverMemoryImport(f.root, f.stores);
    expect(generation.activeGeneration(f.root)).toEqual(pending.next);
    expect(f.open(pending.next).counts().chunks).toBe(2); expect(existsSync(first.generation.indexPath)).toBe(true);
    expect((await f.apply()).status).toBe('already-applied');
  });
  it('recovers after pointer rename but before recording completion, then rolls back atomically', async () => {
    const f = await generationFixture(); const first = await f.apply(); f.open(first.generation).setMeta('edited', '1');
    const original = journal.writeJournal;
    const save = vi.spyOn(journal, 'writeJournal').mockImplementation((root, record) => {
      if (record.phase === 'published') throw new Error('completion interrupted'); original(root, record);
    });
    await expect(f.apply()).rejects.toThrow('completion interrupted'); save.mockRestore();
    const switched = generation.activeGeneration(f.root)!; expect(switched.id).not.toBe(first.generation.id);
    await journal.recoverMemoryImport(f.root, f.stores); expect(generation.activeGeneration(f.root)).toEqual(switched);
    expect(await journal.rollbackMemoryImport(f.root, f.stores)).toEqual(first.generation);
    expect(generation.activeGeneration(f.root)).toEqual(first.generation);
    expect(existsSync(switched.indexPath)).toBe(true); expect(f.remotes.get(switched.collection)?.qdrant).toBe(true);
  });
  it('keeps legacy SQLite and annotations available for the first rollback', async () => {
    const f = await generationFixture(); const legacy = readFileSync(f.legacyPath), annotations = readFileSync(join(f.root, '.memory/annotations.json'));
    await f.apply(); const previous = await journal.rollbackMemoryImport(f.root, f.stores);
    expect(previous.id).toBe('legacy'); expect(readFileSync(previous.indexPath)).toEqual(legacy);
    expect(readFileSync(previous.annotationsPath)).toEqual(annotations);
    expect(f.open(previous).getMeta('legacy')).toBe('keep for rollback');
  });
  it('blocks concurrent writers and releases the OS lock after SIGKILL', async () => {
    const f = await generationFixture();
    // Deliberately kill an independent lock owner, rather than simulating a JS exception.
    const ready = join(f.root, '.memory/lock-ready');
    const id = randomUUID(), dir = generation.generationDir(f.root, id);
    const next = { id, projectId: f.config.projectId, collection: `staging-${id}`, indexPath: join(dir, 'index.db'), annotationsPath: join(dir, 'annotations.json') };
    const record = { version: 1, phase: 'building', next, previous: { id: 'legacy', projectId: f.config.projectId,
      collection: f.config.collection, indexPath: f.legacyPath, annotationsPath: join(f.root, '.memory/annotations.json') } };
    await f.stores(next.collection).qdrant.createFromSnapshot({}); await f.stores(next.collection).typesense.createFromSnapshot({});
    const code = `const {DatabaseSync}=require('node:sqlite'),fs=require('node:fs'); const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); const r=JSON.parse(process.argv[4]); fs.mkdirSync(process.argv[5],{recursive:true}); fs.writeFileSync(process.argv[3],JSON.stringify(r)); fs.writeFileSync(process.argv[2],'locked'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', code, join(f.root, '.memory/mutation-lock.db'), ready,
      journal.journalPath(f.root), JSON.stringify(record), dir], { stdio: 'ignore', env: {} });
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(ready)).toBe(true);
      await expect(f.apply()).rejects.toThrow('locked'); expect(generation.activeGeneration(f.root)).toBeUndefined();
    } finally { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await journal.recoverMemoryImport(f.root, f.stores);
    expect(existsSync(dir)).toBe(false); expect(existsSync(journal.journalPath(f.root))).toBe(false);
    expect(f.remotes.get(next.collection)).toMatchObject({ qdrant: false, typesense: false });
    expect((await f.apply()).status).toBe('imported');
  });
}
