import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryError } from '../shared/errors.js';
import { assertNoSymlink } from '../transfer/paths.js';

/** A dedicated SQLite write transaction holds an OS lock, released even on process death. */
export function acquireMemoryLock(root: string): () => void {
  assertNoSymlink(root, '.memory/mutation-lock.db');
  const dir = join(root, '.memory');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'mutation-lock.db'), { timeout: 0 });
  try { db.exec('BEGIN IMMEDIATE'); }
  catch (error) {
    db.close();
    throw new MemoryError('busy: memory is locked by another writer or snapshot', 'busy');
  }
  return () => { try { db.exec('ROLLBACK'); } finally { db.close(); } };
}

export function withMemoryLockSync<T>(root: string, work: () => T): T {
  const release = acquireMemoryLock(root);
  try { return work(); } finally { release(); }
}

export async function withMemoryLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const release = acquireMemoryLock(root);
  try { return await work(); } finally { release(); }
}
