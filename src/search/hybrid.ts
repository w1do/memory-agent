import type { MemoryContext } from '../shared/context.js';
import type { SearchHit, SearchMode } from '../shared/types.js';
import { rank, type Candidate } from './rank.js';
import { checkFreshness, freshnessWarnings } from './freshness.js';
import { applyBudget, budgetToChars } from './budget.js';
import { makeSnippet } from './snippet.js';
import { redact } from '../security/redact.js';

export interface SearchParams {
  query: string; mode?: SearchMode; limit?: number; path_prefix?: string; language?: string;
  include_snippets?: boolean; token_budget?: number; max_chars?: number;
}

export interface SearchResult {
  hits: SearchHit[]; mode: SearchMode; degraded: boolean; warnings: string[]; truncated: boolean;
}

const MAX_PER_FILE = 2;
const normalize = (values: number[]): number[] => {
  const max = Math.max(...values, 0);
  return values.map((v) => (max > 0 ? v / max : 0));
};

async function lexical(ctx: MemoryContext, p: SearchParams, limit: number, byId: Map<string, Candidate>, text: Map<string, string>) {
  const hits = await ctx.typesense.search(p.query, limit * 3, p.language);
  const norm = normalize(hits.map((h) => h.score));
  hits.forEach(({ doc }, i) => {
    text.set(doc.id, doc.content ?? '');
    byId.set(doc.id, {
      chunkId: doc.id, fileId: doc.file_id, path: doc.path, symbol: doc.symbol, chunkType: doc.chunk_type,
      language: doc.language, lineStart: doc.line_start, lineEnd: doc.line_end, gitCommit: doc.git_commit,
      contentHash: doc.content_hash, indexedAt: new Date(doc.updated_at).toISOString(),
      lexical: norm[i], semantic: 0, imports: doc.imports ?? [], exports: doc.exports ?? [],
    });
  });
}

async function semantic(ctx: MemoryContext, p: SearchParams, limit: number, byId: Map<string, Candidate>) {
  const vector = await ctx.embeddings.embed(p.query);
  const hits = await ctx.qdrant.search(vector, limit * 3, p.language);
  for (const { payload: pl, score } of hits) {
    const existing = byId.get(pl.chunk_id);
    if (existing) { existing.semantic = Math.max(0, score); continue; }
    byId.set(pl.chunk_id, {
      chunkId: pl.chunk_id, fileId: pl.file_id, path: pl.path, symbol: pl.symbol, chunkType: pl.chunk_type,
      language: pl.language, lineStart: pl.line_start, lineEnd: pl.line_end, gitCommit: pl.git_commit,
      contentHash: pl.content_hash, indexedAt: pl.updated_at, lexical: 0, semantic: Math.max(0, score),
      imports: [], exports: [],
    });
  }
}

export async function searchMemory(ctx: MemoryContext, p: SearchParams): Promise<SearchResult> {
  const mode = p.mode ?? 'hybrid';
  const limit = Math.min(p.limit ?? 10, 10);
  const warnings: string[] = [];
  const byId = new Map<string, Candidate>();
  const text = new Map<string, string>();
  let degraded = false;

  if (mode !== 'semantic') await lexical(ctx, p, limit, byId, text);
  if (mode !== 'lexical') {
    try {
      await semantic(ctx, p, limit, byId);
    } catch (e) {
      degraded = true;
      warnings.push(`semantic_search_unavailable: degraded lexical mode (${redact((e as Error).message)})`);
      if (mode === 'semantic') await lexical(ctx, p, limit, byId, text);
    }
  }

  const fresh = checkFreshness(ctx);
  warnings.push(...freshnessWarnings(fresh));
  const prefix = p.path_prefix?.replace(/^\.?\//, '');
  const ranked = rank([...byId.values()].filter((c) => !prefix || c.path.startsWith(prefix)), {
    query: p.query, language: p.language, stale: fresh.stale,
  });

  const perFile = new Map<string, number>();
  const picked = ranked.filter((h) => {
    const n = (perFile.get(h.fileId) ?? 0) + 1;
    perFile.set(h.fileId, n);
    return n <= MAX_PER_FILE;
  }).slice(0, limit);

  if (p.include_snippets !== false) {
    const missing = picked.filter((h) => !text.has(h.chunkId)).map((h) => h.chunkId);
    for (const [id, c] of await ctx.typesense.contentOf(missing)) text.set(id, c);
    picked.forEach((h) => { const c = text.get(h.chunkId); if (c) h.snippet = makeSnippet(c, p.query); });
  }
  const { items, truncated } = applyBudget(picked, budgetToChars(p.token_budget, p.max_chars));
  return { hits: items, mode, degraded, warnings, truncated };
}
