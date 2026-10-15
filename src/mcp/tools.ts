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
import { resolveInside } from '../project/paths.js';
import { hasForbiddenExtension } from '../security/policy.js';
import { redact } from '../security/redact.js';
import { MemoryError } from '../shared/errors.js';
import type { ContextResolver } from './projects.js';

export const ANNOTATION_MAX_LENGTH = 200;
export const ANNOTATION_ROLES = ['module', 'entry', 'test', 'config', 'doc', 'other'] as const;

export interface AnnotateInput {
  path: string;
  summary: string;
  role: (typeof ANNOTATION_ROLES)[number];
  content_hash: string;
}

/** Stores an agent annotation only for an indexed, non-excluded file whose hash matches the index. Never touches project files. */
export function annotateFile(ctx: MemoryContext, input: AnnotateInput) {
  const { rel } = resolveInside(ctx.root, input.path);
  if (ctx.matcher.matches(rel) || hasForbiddenExtension(rel)) {
    throw new MemoryError(`Annotation refused by memory policy: ${rel}`, 'access_denied');
  }
  const file = ctx.manifest.getFile(rel);
  if (!file) throw new MemoryError(`File is not indexed: ${rel}`, 'not_indexed');
  if (file.sha256 !== input.content_hash) {
    throw new MemoryError(`content_hash does not match the indexed file: ${rel}. Run memory_update first.`, 'hash_mismatch');
  }
  const summary = input.summary.trim();
  if (!summary || summary.length > ANNOTATION_MAX_LENGTH) {
    throw new MemoryError(`summary must be 1..${ANNOTATION_MAX_LENGTH} characters`, 'invalid_summary');
  }
  if (redact(summary) !== summary) {
    throw new MemoryError('summary contains sensitive values and was refused', 'secret_detected');
  }
  ctx.manifest.upsertAnnotation({
    relativePath: rel, summary, role: input.role, contentHash: file.sha256, author: 'agent', updatedAt: new Date().toISOString(),
  });
  ctx.logger.info(`memory_annotate: ${rel}`);
  return { path: rel, role: input.role, content_hash: file.sha256, saved: true };
}

const project = { project: z.string().optional().describe('Project directory; default: project of the current working directory') };
const budget = {
  token_budget: z.number().int().positive().max(20000).optional().describe('Approximate token limit for the response'),
  max_chars: z.number().int().positive().max(80000).optional().describe('Hard character limit for the response'),
};

/** Registers all MCP tools. None of them modifies project source files. */
export function registerTools(server: McpServer, resolve: ContextResolver): void {
  server.registerTool('memory_search', {
    description: 'Search project memory (hybrid lexical + semantic). Returns compact hits, never whole files.',
    inputSchema: {
      ...project,
      query: z.string().min(1),
      mode: z.enum(['hybrid', 'lexical', 'semantic']).optional(),
      limit: z.number().int().min(1).max(10).optional(),
      path_prefix: z.string().optional(),
      language: z.string().optional(),
      include_snippets: z.boolean().optional(),
      ...budget,
    },
  }, safe((a) => searchMemory(resolve(a.project), a)));

  server.registerTool('memory_get_context', {
    description: 'Compact task context: files, modules, symbols, relations, snippets, index status and hashes.',
    inputSchema: {
      ...project, query: z.string().min(1), ...budget },
  }, safe((a) => buildContext(resolve(a.project), a.query, a)));

  server.registerTool('memory_get_file', {
    description: 'Read one file or a line range (max 500 lines). Excluded/secret files are refused.',
    inputSchema: {
      ...project, path: z.string(), line_start: z.number().int().min(1).optional(), line_end: z.number().int().min(1).optional() },
  }, safe((a) => readFileSlice(resolve(a.project), a.path, a.line_start, a.line_end)));

  server.registerTool('memory_related', {
    description: 'Files related to a path via imports, tests, docs, packages and shared module.',
    inputSchema: {
      ...project, path: z.string(), depth: z.number().int().min(1).max(3).optional(), limit: z.number().int().min(1).max(100).optional() },
  }, safe((a) => ({ path: a.path, related: relatedFiles(resolve(a.project), a.path, a.depth ?? 1, a.limit ?? 30) })));

  server.registerTool('memory_update', {
    description: 'Re-index only the given project files after you changed them. Paths must be inside the project.',
    inputSchema: {
      ...project, paths: z.array(z.string()).min(1).max(100), reason: z.string().optional() },
  }, safe(async (a) => {
    const ctx = resolve(a.project);
    ctx.logger.info(`memory_update: ${a.paths.length} path(s)${a.reason ? ` — ${a.reason}` : ''}`);
    return { results: await updatePaths(ctx, a.paths) };
  }));

  server.registerTool('memory_sync', {
    description: 'Synchronise the whole project; unchanged files are not re-read.',
    inputSchema: {
      ...project },
  }, safe(async (a) => {
    const r = await syncProject(resolve(a.project));
    return { added: r.added.length, changed: r.changed.length, renamed: r.renamed.length, removed: r.removed.length, unchanged: r.unchanged, errors: r.errors, semantic: r.semantic };
  }));

  server.registerTool('memory_annotate', {
    description: 'Save a short agent-written summary (max 200 chars) for an indexed file. Requires the current content_hash of the file.',
    inputSchema: {
      ...project,
      path: z.string().min(1),
      summary: z.string().min(1).max(ANNOTATION_MAX_LENGTH),
      role: z.enum(ANNOTATION_ROLES),
      content_hash: z.string().min(1),
    },
  }, safe((a) => annotateFile(resolve(a.project), a)));

  server.registerTool('memory_status', {
    description: 'State of Qdrant, Typesense, embeddings, counts, last sync, stale files and search mode.',
    inputSchema: {
      ...project },
  }, safe((a) => getStatus(resolve(a.project))));

  server.registerTool('memory_project_structure', {
    description: 'Compact project tree (no file contents).',
    inputSchema: {
      ...project, depth: z.number().int().min(1).max(6).optional() },
  }, safe((a) => ({ tree: projectStructure(resolve(a.project), a.depth ?? 3), stale: [...checkFreshness(resolve(a.project)).stale].slice(0, 20) })));
}
