import type { MemoryContext } from '../shared/context.js';
import { searchMemory } from './hybrid.js';
import { applyBudget, budgetToChars } from './budget.js';
import { tokenize } from './snippet.js';
import { moduleOf } from '../indexing/relations.js';

export interface AgentContext {
  query: string;
  files: Array<{ path: string; language: string; indexed_at: string; content_hash: string; is_stale: boolean; git_commit: string }>;
  modules: Array<{ directory: string; files: number }>;
  symbols: Array<{ name: string; kind: string; path: string; line: number }>;
  relations: Array<{ from: string; to: string; kind: string }>;
  snippets: Array<{ path: string; lines: string; symbol: string; snippet?: string }>;
  warnings: string[];
  index_status: Record<string, unknown>;
  source_hashes: Record<string, string>;
  truncated: boolean;
}

/** One compact answer for "where is X and what is related to it": no full files, bounded size. */
export async function buildContext(
  ctx: MemoryContext, query: string, opts: { token_budget?: number; max_chars?: number } = {},
): Promise<AgentContext> {
  const search = await searchMemory(ctx, { query, limit: 8, include_snippets: true });
  const topPaths = [...new Set(search.hits.map((h) => h.path))];
  const files = topPaths.map((p) => {
    const h = search.hits.find((x) => x.path === p)!;
    return { path: p, language: h.language, indexed_at: h.indexed_at, content_hash: h.content_hash, is_stale: h.is_stale, git_commit: h.git_commit };
  });

  const moduleCount = new Map<string, number>();
  topPaths.forEach((p) => moduleCount.set(moduleOf(p), (moduleCount.get(moduleOf(p)) ?? 0) + 1));

  const symbols = new Map<string, AgentContext['symbols'][number]>();
  for (const term of tokenize(query).slice(0, 5)) {
    for (const s of ctx.manifest.findSymbols(term, 5)) symbols.set(`${s.path}:${s.name}`, { name: s.name, kind: s.kind, path: s.path, line: s.lineStart });
  }
  for (const h of search.hits) if (h.symbol) symbols.set(`${h.path}:${h.symbol}`, { name: h.symbol, kind: h.chunkType, path: h.path, line: h.lineStart });

  const relations = topPaths.slice(0, 4).flatMap((p) => ctx.manifest.relationsFrom(p).slice(0, 8).map((r) => ({ from: r.fromPath, to: r.toPath, kind: r.kind })));
  const snippets = search.hits.map((h) => ({ path: h.path, lines: `${h.lineStart}-${h.lineEnd}`, symbol: h.symbol, snippet: h.snippet }));
  const fitted = applyBudget(snippets, Math.floor(budgetToChars(opts.token_budget, opts.max_chars) * 0.6));

  const hashes: Record<string, string> = {};
  files.forEach((f) => { hashes[f.path] = f.content_hash; });
  const counts = ctx.manifest.counts();
  return {
    query, files, modules: [...moduleCount].map(([directory, n]) => ({ directory, files: n })),
    symbols: [...symbols.values()].slice(0, 20), relations, snippets: fitted.items,
    warnings: search.warnings,
    index_status: { files: counts.files, chunks: counts.chunks, errors: counts.errors, last_sync_at: ctx.manifest.getMeta('last_sync_at') ?? null, mode: search.degraded ? 'degraded_lexical' : 'hybrid' },
    source_hashes: hashes, truncated: fitted.truncated || search.truncated,
  };
}
