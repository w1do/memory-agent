import type { SearchHit } from '../shared/types.js';
import { moduleOf } from '../indexing/relations.js';
import { tokenize } from './snippet.js';

export interface Candidate {
  chunkId: string; fileId: string; path: string; symbol: string; chunkType: string; language: string;
  lineStart: number; lineEnd: number; gitCommit: string; contentHash: string; indexedAt: string;
  lexical: number; semantic: number; imports: string[]; exports: string[];
}

export interface RankContext { query: string; language?: string; stale: Set<string>; now?: number }

const lastSegment = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Deterministic reranking (no LLM). Weights follow the required priority order. */
export function rank(cands: Candidate[], rc: RankContext): SearchHit[] {
  const q = rc.query.trim().toLowerCase();
  const terms = tokenize(rc.query);
  const topLexical = [...cands].sort((a, b) => b.lexical - a.lexical)[0];
  const topModule = topLexical && topLexical.lexical > 0 ? moduleOf(topLexical.path) : '';
  const now = rc.now ?? Date.now();

  return cands.map((c) => {
    const path = c.path.toLowerCase();
    const name = lastSegment(path);
    let score = c.lexical * 1.0 + c.semantic * 1.2;
    if (q && (path === q || path.endsWith(`/${q}`))) score += 3;
    if (c.symbol && terms.includes(c.symbol.toLowerCase())) score += 2;
    if (terms.some((t) => name === t || name.replace(/\.[^.]+$/, '') === t)) score += 1.2;
    const names = [...c.imports, ...c.exports].map((s) => s.toLowerCase());
    if (terms.some((t) => names.includes(t))) score += 0.5;
    if (rc.language && c.language === rc.language) score += 0.1;
    if (topModule && moduleOf(c.path) === topModule) score += 0.15;
    const isStale = rc.stale.has(c.path);
    const ageDays = (now - Date.parse(c.indexedAt)) / 86_400_000;
    score += isStale ? -0.2 : Math.max(0, 0.1 - ageDays * 0.01);
    return {
      chunkId: c.chunkId, fileId: c.fileId, path: c.path, symbol: c.symbol, chunkType: c.chunkType,
      language: c.language, lineStart: c.lineStart, lineEnd: c.lineEnd, score: Number(score.toFixed(4)),
      lexicalScore: Number(c.lexical.toFixed(4)), semanticScore: Number(c.semantic.toFixed(4)),
      indexed_at: c.indexedAt, content_hash: c.contentHash, is_stale: isStale, git_commit: c.gitCommit,
    };
  }).sort((a, b) => b.score - a.score);
}
