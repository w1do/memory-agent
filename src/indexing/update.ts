import { existsSync, statSync } from 'node:fs';
import type { MemoryContext } from '../shared/context.js';
import { resolveInside } from '../project/paths.js';
import { isIndexable } from '../project/scan.js';
import { redact } from '../security/redact.js';
import { FileIndexer } from './file-indexer.js';
import { rebuildRelations } from './rebuild-relations.js';

export interface UpdateResult {
  path: string;
  status: 'indexed' | 'removed' | 'skipped' | 'error';
  sha256?: string;
  reason?: string;
}

/** Re-reads only the given paths. Throws PathOutsideProjectError for paths escaping the root. */
export async function updatePaths(ctx: MemoryContext, paths: string[]): Promise<UpdateResult[]> {
  const targets = paths.map((p) => resolveInside(ctx.root, p));
  await ctx.typesense.ensureCollection();
  const indexer = new FileIndexer(ctx);
  indexer.setKnownPaths(ctx.manifest.listFiles(), targets.map((t) => t.rel));
  const results: UpdateResult[] = [];

  for (const { abs, rel } of targets) {
    const known = ctx.manifest.getFile(rel);
    if (!existsSync(abs)) {
      if (known) {
        await ctx.typesense.deleteByFile(known.id);
        await ctx.qdrant.deleteByFile(known.id);
        ctx.manifest.deleteFile(known.id);
        results.push({ path: rel, status: 'removed' });
      } else results.push({ path: rel, status: 'skipped', reason: 'not found' });
      continue;
    }
    const st = statSync(abs);
    const language = st.isFile() ? isIndexable(ctx.matcher, rel, st.size, ctx.config.maxFileSize) : null;
    if (!language) { results.push({ path: rel, status: 'skipped', reason: 'excluded by policy' }); continue; }
    try {
      const outcome = await indexer.index({ relativePath: rel, absolutePath: abs, mtimeMs: Math.floor(st.mtimeMs), language });
      results.push({ path: rel, status: outcome, sha256: ctx.manifest.getFile(rel)?.sha256 });
    } catch (e) {
      const message = redact((e as Error).message);
      ctx.manifest.recordError(rel, message);
      results.push({ path: rel, status: 'error', reason: message });
    }
  }
  rebuildRelations(ctx);
  return results;
}
