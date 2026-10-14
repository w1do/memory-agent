import type { MemoryContext } from '../shared/context.js';
import { buildRelations, nonTestStems, PathIndex } from './relations.js';

/** Recomputes relations from manifest data only (no file reads), so new/removed files get linked. */
export function rebuildRelations(ctx: MemoryContext): void {
  const { manifest } = ctx;
  const files = manifest.listFiles();
  const index = new PathIndex(files.map((f) => f.relativePath));
  const stems = nonTestStems(files);
  manifest.tx(() => {
    for (const f of files) {
      manifest.replaceRelations(f.relativePath, buildRelations(f, manifest.importsOf(f.id), index, stems));
    }
  });
}
