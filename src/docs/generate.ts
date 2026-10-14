import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MemoryContext } from '../shared/context.js';
import { projectStructure } from '../project/structure.js';
import { memoryDir } from '../project/config.js';
import { gitCommit } from '../project/git.js';
import { INDEX_VERSION, type FileRecord } from '../shared/types.js';

const ENTRY_RE = /(^|\/)(index|main|app|server|cli|cmd\/[^/]+\/main|__main__|manage)\.[a-z]+$/;

const list = (items: string[], empty = '_none found in index_'): string =>
  items.length ? items.map((i) => `- ${i}`).join('\n') : empty;

/** Builds Markdown strictly from indexed facts (manifest) — nothing is inferred or invented. */
export function renderDocs(ctx: MemoryContext): string {
  const files = ctx.manifest.listFiles();
  const paths = (pred: (f: FileRecord) => boolean) => files.filter(pred).map((f) => `\`${f.relativePath}\``);
  const dirs = new Map<string, number>();
  files.forEach((f) => { const d = f.relativePath.includes('/') ? f.relativePath.split('/').slice(0, 2).join('/') : '.'; dirs.set(d, (dirs.get(d) ?? 0) + 1); });
  const pkgs = files.filter((f) => f.relativePath.endsWith('package.json')).map((f) => `\`${f.relativePath}\`: ${ctx.manifest.importsOf(f.id).length} dependencies`);
  const hubs = files.map((f) => ({ f, n: ctx.manifest.relationsTo(f.relativePath).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 15);
  const testDirs = [...new Set(files.filter((f) => f.isTest).map((f) => f.relativePath.split('/').slice(0, -1).join('/') || '.'))];

  return [
    `# Project memory: ${ctx.config.projectName}`, '',
    `- Generated at: ${new Date().toISOString()}`,
    `- Git commit: ${gitCommit(ctx.root) || 'n/a'}`,
    `- Index version: ${INDEX_VERSION}`,
    `- Files: ${files.length}, chunks: ${ctx.manifest.counts().chunks}`, '',
    '## Structure', '', '```', projectStructure(ctx, 2, 80), '```', '',
    '## Main modules (top-level directories by file count)', '',
    list([...dirs].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([d, n]) => `\`${d}\` — ${n} files`)), '',
    '## Entry points (by file name)', '', list(paths((f) => ENTRY_RE.test(f.relativePath) && !f.isTest)), '',
    '## Packages', '', list(pkgs), '',
    '## Most referenced files', '', list(hubs.map((h) => `\`${h.f.relativePath}\` — referenced by ${h.n} file(s)`)), '',
    '## Test directories', '', list(testDirs.map((d) => `\`${d}\``)), '',
    '## Configuration files', '', list(paths((f) => f.isConfig && !f.relativePath.endsWith('.lock'))), '',
    '## Documentation', '', list(paths((f) => f.isDocumentation)), '',
  ].join('\n');
}

export function generateDocs(ctx: MemoryContext): string {
  const target = join(memoryDir(ctx.root), 'generated', 'project-memory.md');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderDocs(ctx));
  return target;
}
