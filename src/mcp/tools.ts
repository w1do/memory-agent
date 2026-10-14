import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemoryContext } from '../shared/context.js';
import { searchMemory } from '../search/hybrid.js';
import { buildContext } from '../search/context.js';
import { relatedFiles } from '../search/related.js';
import { readFileSlice } from '../project/read-file.js';
import { projectStructure } from '../project/structure.js';
import { getStatus } from '../project/status.js';
import { updatePaths } from '../indexing/update.js';
import { syncProject } from '../indexing/sync.js';
import { checkFreshness } from '../search/freshness.js';
import { safe } from './result.js';

const budget = {
  token_budget: z.number().int().positive().max(20000).optional().describe('Approximate token limit for the response'),
  max_chars: z.number().int().positive().max(80000).optional().describe('Hard character limit for the response'),
};

/** Registers all MCP tools. None of them modifies project source files. */
export function registerTools(server: McpServer, ctx: MemoryContext): void {
  server.registerTool('memory_search', {
    description: 'Search project memory (hybrid lexical + semantic). Returns compact hits, never whole files.',
    inputSchema: {
      query: z.string().min(1),
      mode: z.enum(['hybrid', 'lexical', 'semantic']).optional(),
      limit: z.number().int().min(1).max(10).optional(),
      path_prefix: z.string().optional(),
      language: z.string().optional(),
      include_snippets: z.boolean().optional(),
      ...budget,
    },
  }, safe((a) => searchMemory(ctx, a)));

  server.registerTool('memory_get_context', {
    description: 'Compact task context: files, modules, symbols, relations, snippets, index status and hashes.',
    inputSchema: { query: z.string().min(1), ...budget },
  }, safe((a) => buildContext(ctx, a.query, a)));

  server.registerTool('memory_get_file', {
    description: 'Read one file or a line range (max 500 lines). Excluded/secret files are refused.',
    inputSchema: { path: z.string(), line_start: z.number().int().min(1).optional(), line_end: z.number().int().min(1).optional() },
  }, safe((a) => readFileSlice(ctx, a.path, a.line_start, a.line_end)));

  server.registerTool('memory_related', {
    description: 'Files related to a path via imports, tests, docs, packages and shared module.',
    inputSchema: { path: z.string(), depth: z.number().int().min(1).max(3).optional(), limit: z.number().int().min(1).max(100).optional() },
  }, safe((a) => ({ path: a.path, related: relatedFiles(ctx, a.path, a.depth ?? 1, a.limit ?? 30) })));

  server.registerTool('memory_update', {
    description: 'Re-index only the given project files after you changed them. Paths must be inside the project.',
    inputSchema: { paths: z.array(z.string()).min(1).max(100), reason: z.string().optional() },
  }, safe(async (a) => {
    ctx.logger.info(`memory_update: ${a.paths.length} path(s)${a.reason ? ` — ${a.reason}` : ''}`);
    return { results: await updatePaths(ctx, a.paths) };
  }));

  server.registerTool('memory_sync', {
    description: 'Synchronise the whole project; unchanged files are not re-read.',
    inputSchema: {},
  }, safe(async () => {
    const r = await syncProject(ctx);
    return { added: r.added.length, changed: r.changed.length, renamed: r.renamed.length, removed: r.removed.length, unchanged: r.unchanged, errors: r.errors, semantic: r.semantic };
  }));

  server.registerTool('memory_status', {
    description: 'State of Qdrant, Typesense, embeddings, counts, last sync, stale files and search mode.',
    inputSchema: {},
  }, safe(() => getStatus(ctx)));

  server.registerTool('memory_project_structure', {
    description: 'Compact project tree (no file contents).',
    inputSchema: { depth: z.number().int().min(1).max(6).optional() },
  }, safe((a) => ({ tree: projectStructure(ctx, a.depth ?? 3), stale: [...checkFreshness(ctx).stale].slice(0, 20) })));
}
