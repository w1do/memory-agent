import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { activeGeneration, durableJson, flushFile, generationDir, generationSchema, publishGeneration, type Generation } from '../storage/generation.js';
import { withMemoryLock } from '../storage/memory-lock.js';
import { assertNoSymlink } from './paths.js';
import type { StoreFactory } from './import-stores.js';

const journalSchema = z.strictObject({ version: z.literal(1), phase: z.enum(['building', 'ready', 'published']),
  next: generationSchema, previous: generationSchema });
export type ImportJournal = z.infer<typeof journalSchema>;
export const journalPath = (root: string): string => join(root, '.memory', 'import-operation.json');

export function writeJournal(root: string, journal: ImportJournal): void {
  assertNoSymlink(root, '.memory/import-operation.json');
  durableJson(journalPath(root), journalSchema.parse(journal));
}

export function finishJournal(root: string): void {
  rmSync(journalPath(root), { force: true });
  flushFile(join(root, '.memory'));
}

/** Lock must be held. Cleanup is retryable even if only one service was created/deleted. */
export async function recoverImportLocked(root: string, stores: StoreFactory): Promise<void> {
  assertNoSymlink(root, '.memory/import-operation.json');
  if (!existsSync(journalPath(root))) return;
  const journal = journalSchema.parse(JSON.parse(readFileSync(journalPath(root), 'utf8')));
  const active = activeGeneration(root);
  if (journal.phase === 'building' && active?.id !== journal.next.id) {
    const staging = stores(journal.next.collection);
    await staging.qdrant.dropCollection();
    await staging.typesense.dropCollection();
    rmSync(generationDir(root, journal.next.id), { recursive: true, force: true });
  } else {
    // Ready is persisted only after all components and rollback metadata have been flushed.
    const dir = generationDir(root, journal.next.id);
    if (!existsSync(join(dir, 'index.db')) || !existsSync(join(dir, 'annotations.json'))) {
      publishGeneration(root, journal.previous);
      const staging = stores(journal.next.collection);
      await staging.qdrant.dropCollection();
      await staging.typesense.dropCollection();
      rmSync(dir, { recursive: true, force: true });
    } else publishGeneration(root, journal.next);
  }
  finishJournal(root);
}

export async function recoverMemoryImport(root: string, stores: StoreFactory): Promise<void> {
  return withMemoryLock(root, () => recoverImportLocked(root, stores));
}

/** A rollback is another single pointer replacement. Neither generation is deleted. */
export async function rollbackMemoryImport(root: string, stores: StoreFactory): Promise<Generation> {
  return withMemoryLock(root, async () => {
    await recoverImportLocked(root, stores);
    const active = activeGeneration(root);
    if (!active || active.id === 'legacy') throw new Error('No imported generation to roll back');
    const file = join(generationDir(root, active.id), 'previous.json');
    assertNoSymlink(root, `.memory/generations/${active.id}/previous.json`);
    const previous = generationSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    publishGeneration(root, previous);
    return previous;
  });
}
