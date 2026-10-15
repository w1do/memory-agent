import { existsSync } from 'node:fs';
import { withContext } from '../common.js';
import { searchMemory } from '../../search/hybrid.js';
import { generateDocs } from '../../docs/generate.js';
import { runStdio } from '../../mcp/server.js';
import { configPath } from '../../project/config.js';
import { rootFrom } from '../common.js';
import { MemoryError } from '../../shared/errors.js';
import type { SearchMode } from '../../shared/types.js';

export interface SearchOptions { path?: string; mode?: SearchMode; limit?: string; language?: string; json?: boolean; maxChars?: string; snippets?: boolean }

export const searchCommand = (query: string, o: SearchOptions) => withContext(o.path, async (ctx) => {
  const r = await searchMemory(ctx, {
    query, mode: o.mode, limit: o.limit ? Number(o.limit) : undefined, language: o.language,
    max_chars: o.maxChars ? Number(o.maxChars) : undefined,
  });
  if (o.json) return console.log(JSON.stringify(r, null, 2));
  if (r.degraded) console.log('! degraded lexical mode: semantic search is unavailable');
  r.warnings.filter((w) => !w.startsWith('semantic_search_unavailable')).forEach((w) => console.log(`! ${w}`));
  if (!r.hits.length) return console.log('No results.');
  if (!o.snippets) {
    const seen = new Set<string>();
    for (const h of r.hits) {
      if (seen.has(h.path)) continue;
      seen.add(h.path);
      console.log(h.is_stale ? `${h.path}  STALE` : h.path);
      if (h.annotation) console.log(`    ${h.annotation}`);
    }
    return;
  }
  for (const h of r.hits) {
    console.log(`${h.path}:${h.lineStart}-${h.lineEnd}  ${h.symbol || h.chunkType}  score=${h.score}${h.is_stale ? '  STALE' : ''}`);
    if (h.annotation) console.log(`    ${h.annotation}`);
    if (h.snippet) console.log(h.snippet.split('\n').map((l) => `    ${l}`).join('\n'));
  }
});

export const docsCommand = (o: { path?: string }) => withContext(o.path, async (ctx) => console.log(`Written ${generateDocs(ctx)}`));

export async function mcpCommand(o: { project?: string }): Promise<void> {
  if (o.project) {
    const root = rootFrom(o.project);
    if (!existsSync(configPath(root))) throw new MemoryError(`Project memory is not initialized in ${root}: run "memory init" first`, 'not_initialized');
  }
  await runStdio(o.project);
}
