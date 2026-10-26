import type { MemoryContext } from '../shared/context.js';
import { scanProject } from '../project/scan.js';

export interface Freshness {
  stale: Set<string>;
  deleted: string[];
  added: string[];
}

/** Lightweight check: stat() only — compares size/mtime with the manifest, never reads file contents. */
export function checkFreshness(ctx: MemoryContext): Freshness {
  const known = new Map(ctx.manifest.listFiles().map((f) => [f.relativePath, f]));
  const stale = new Set<string>();
  const added: string[] = [];
  for (const s of scanProject(ctx.root, ctx.matcher, ctx.config.maxFileSize)) {
    const old = known.get(s.relativePath);
    known.delete(s.relativePath);
    if (!old) added.push(s.relativePath);
    else if (old.status === 'stale' || old.size !== s.size || old.mtimeMs !== s.mtimeMs) stale.add(s.relativePath);
  }
  const deleted = [...known.keys()];
  deleted.forEach((p) => stale.add(p));
  return { stale, deleted, added };
}

export function freshnessWarnings(f: Freshness): string[] {
  const out: string[] = [];
  const changed = f.stale.size - f.deleted.length;
  if (changed > 0) out.push(`Index is stale for ${changed} modified file(s); run memory_sync or memory_update.`);
  if (f.deleted.length) out.push(`${f.deleted.length} indexed file(s) no longer exist on disk.`);
  if (f.added.length) out.push(`${f.added.length} new file(s) are not indexed yet.`);
  return out;
}
