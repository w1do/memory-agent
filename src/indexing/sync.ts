import { readFileSync } from 'node:fs';
import type { MemoryContext } from '../shared/context.js';
import { sha256 } from '../shared/hash.js';
import { gitBranch, gitCommit, gitDirtyPaths } from '../project/git.js';
import { scanProject, type ScannedFile } from '../project/scan.js';
import { redact } from '../security/redact.js';
import { FileIndexer } from './file-indexer.js';
import type { FileRecord } from '../shared/types.js';
import { rebuildRelations } from './rebuild-relations.js';

export interface SyncReport {
  added: string[]; changed: string[]; renamed: Array<{ from: string; to: string }>;
  removed: string[]; unchanged: number; errors: Array<{ path: string; message: string }>;
  semantic: 'ok' | 'unavailable' | 'unknown'; semanticError: string;
}

export interface Changes {
  added: ScannedFile[]; changed: ScannedFile[]; removed: FileRecord[];
  renamed: Array<{ from: FileRecord; to: ScannedFile }>; unchanged: number; scanned: ScannedFile[];
}

/** Cheap change detection: stat() first, hash only when size/mtime/git status suggest a change. */
export function detectChanges(ctx: MemoryContext, force: Set<string> = new Set()): Changes {
  const scanned = scanProject(ctx.root, ctx.matcher, ctx.config.maxFileSize);
  const known = new Map(ctx.manifest.listFiles().map((f) => [f.relativePath, f]));
  const dirty = gitDirtyPaths(ctx.root);
  const commit = gitCommit(ctx.root);
  const branch = gitBranch(ctx.root);
  const changes: Changes = { added: [], changed: [], removed: [], renamed: [], unchanged: 0, scanned };

  for (const s of scanned) {
    const old = known.get(s.relativePath);
    known.delete(s.relativePath);
    if (!old) { changes.added.push(s); continue; }
    if (force.has(s.relativePath)) { changes.changed.push(s); continue; }
    const suspicious = old.size !== s.size || old.mtimeMs !== s.mtimeMs || dirty.has(s.relativePath);
    if (suspicious && sha256(readFileSync(s.absolutePath)) !== old.sha256) { changes.changed.push(s); continue; }
    if (old.mtimeMs !== s.mtimeMs || old.gitCommit !== commit) ctx.manifest.touchFile(old.id, s.mtimeMs, commit, branch);
    changes.unchanged++;
  }
  changes.removed = [...known.values()];
  pairRenames(changes);
  return changes;
}

function pairRenames(changes: Changes): void {
  for (const gone of [...changes.removed]) {
    const match = changes.added.find((a) => a.size === gone.size && sha256(readFileSync(a.absolutePath)) === gone.sha256);
    if (!match) continue;
    changes.renamed.push({ from: gone, to: match });
  }
}

async function removeFile(ctx: MemoryContext, file: FileRecord): Promise<void> {
  await ctx.typesense.deleteByFile(file.id);
  await ctx.qdrant.deleteByFile(file.id);
  ctx.manifest.deleteFile(file.id);
}

export async function syncProject(ctx: MemoryContext, opts: { force?: string[]; kind?: string } = {}): Promise<SyncReport> {
  const { manifest } = ctx;
  await ctx.typesense.ensureCollection();
  const force = new Set(opts.force ?? []);
  if (manifest.pathsWithUnembedded().length && (await ctx.embeddings.health()).ok) {
    manifest.pathsWithUnembedded().forEach((p) => force.add(p));
  }
  const changes = detectChanges(ctx, force);
  const runId = manifest.startRun(opts.kind ?? 'sync');
  const report: SyncReport = {
    added: changes.added.map((f) => f.relativePath), changed: changes.changed.map((f) => f.relativePath),
    renamed: changes.renamed.map((r) => ({ from: r.from.relativePath, to: r.to.relativePath })),
    removed: changes.removed.map((f) => f.relativePath), unchanged: changes.unchanged,
    errors: [], semantic: 'unknown', semanticError: '',
  };

  for (const f of changes.removed) await removeFile(ctx, f);
  const indexer = new FileIndexer(ctx);
  indexer.setKnownPaths(manifest.listFiles(), changes.scanned.map((s) => s.relativePath));
  for (const f of [...changes.added, ...changes.changed]) {
    try {
      await indexer.index(f);
    } catch (e) {
      const message = redact((e as Error).message);
      manifest.recordError(f.relativePath, message);
      report.errors.push({ path: f.relativePath, message });
    }
  }
  if (changes.added.length || changes.removed.length) rebuildRelations(ctx);
  report.semantic = indexer.semantic;
  report.semanticError = indexer.semanticError;
  manifest.finishRun(runId, report.added.length + report.changed.length, report.removed.length, report.errors.length);
  return report;
}
