import { readFileSync, statSync } from 'node:fs';
import type { MemoryContext } from '../shared/context.js';
import { MemoryError } from '../shared/errors.js';
import { sha256 } from '../shared/hash.js';
import { hasForbiddenExtension } from '../security/policy.js';
import { redact } from '../security/redact.js';
import { resolveInside } from './paths.js';

export const DEFAULT_LINES = 200;
export const MAX_LINES = 500;

export interface FileSlice {
  path: string; line_start: number; line_end: number; total_lines: number;
  content: string; sha256: string; indexed_hash: string | null; is_stale: boolean; truncated: boolean;
}

/** Read-only access to one file (or range) inside the project; secrets and excluded paths are refused. */
export function readFileSlice(ctx: MemoryContext, path: string, from?: number, to?: number): FileSlice {
  const { abs, rel } = resolveInside(ctx.root, path);
  if (ctx.matcher.matches(rel) || hasForbiddenExtension(rel)) {
    throw new MemoryError(`Access denied by memory policy: ${rel}`, 'access_denied');
  }
  if (!statSync(abs, { throwIfNoEntry: false })?.isFile()) throw new MemoryError(`File not found: ${rel}`, 'not_found');
  const raw = readFileSync(abs);
  const lines = raw.toString('utf8').split('\n');
  const start = Math.max(1, from ?? 1);
  const wanted = Math.min(to ?? start + DEFAULT_LINES - 1, lines.length);
  const end = Math.min(wanted, start + MAX_LINES - 1);
  const indexed = ctx.manifest.getFile(rel);
  const hash = sha256(raw);
  return {
    path: rel, line_start: start, line_end: end, total_lines: lines.length,
    content: redact(lines.slice(start - 1, end).join('\n')), sha256: hash,
    indexed_hash: indexed?.sha256 ?? null, is_stale: !indexed || indexed.sha256 !== hash, truncated: end < wanted,
  };
}
