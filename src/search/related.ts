import type { MemoryContext } from '../shared/context.js';
import { moduleOf } from '../indexing/relations.js';
import { resolveInside } from '../project/paths.js';

export interface RelatedFile { path: string; relation: string; depth: number; direction: 'out' | 'in' | 'module' }

export function relatedFiles(ctx: MemoryContext, path: string, depth = 1, limit = 30): RelatedFile[] {
  const { rel } = resolveInside(ctx.root, path);
  const seen = new Map<string, RelatedFile>();
  let frontier = [rel];
  for (let d = 1; d <= Math.min(depth, 3); d++) {
    const next: string[] = [];
    for (const current of frontier) {
      const edges = [
        ...ctx.manifest.relationsFrom(current).map((r) => ({ to: r.toPath, kind: r.kind, dir: 'out' as const })),
        ...ctx.manifest.relationsTo(current).map((r) => ({ to: r.fromPath, kind: r.kind, dir: 'in' as const })),
      ];
      for (const e of edges) {
        if (e.to === rel || seen.has(e.to)) continue;
        seen.set(e.to, { path: e.to, relation: e.kind, depth: d, direction: e.dir });
        if (!e.to.startsWith('pkg:')) next.push(e.to);
      }
    }
    frontier = next;
  }
  const mod = moduleOf(rel);
  for (const f of ctx.manifest.listFiles()) {
    if (f.relativePath !== rel && !seen.has(f.relativePath) && moduleOf(f.relativePath) === mod) {
      seen.set(f.relativePath, { path: f.relativePath, relation: 'module', depth: 1, direction: 'module' });
    }
  }
  return [...seen.values()].sort((a, b) => a.depth - b.depth).slice(0, limit);
}
