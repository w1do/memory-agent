import { resolve } from 'node:path';
import { findProjectRoot } from '../project/root.js';
import { openContext, type MemoryContext } from '../shared/context.js';
import { MemoryError } from '../shared/errors.js';
import { redact } from '../security/redact.js';
import type { SyncReport } from '../indexing/sync.js';

export const rootFrom = (path?: string): string => findProjectRoot(path ? resolve(path) : process.cwd());

export async function withContext<T>(path: string | undefined, fn: (ctx: MemoryContext) => Promise<T>,
  opts: { exportAnnotationsOnClose?: boolean } = {}): Promise<T> {
  const ctx = openContext(rootFrom(path), opts);
  try { return await fn(ctx); } finally { ctx.close(); }
}

export const printSync = (r: SyncReport): void => {
  console.log(`added ${r.added.length}, changed ${r.changed.length}, renamed ${r.renamed.length}, removed ${r.removed.length}, unchanged ${r.unchanged}, errors ${r.errors.length}`);
  r.errors.slice(0, 5).forEach((e) => console.log(`  ! ${e.path}: ${e.message}`));
  if (r.semantic === 'unavailable') console.log(`  semantic_search_unavailable: degraded lexical mode (${r.semanticError})`);
};

export const handleError = (e: unknown): never => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`Error: ${redact(msg)}`);
  process.exit(e instanceof MemoryError ? 2 : 1);
};
