import { readFileSync } from 'node:fs';
import type { MemoryContext } from '../shared/context.js';
import { sha256 } from '../shared/hash.js';
import { gitBranch, gitCommit, gitDirtyPaths } from '../project/git.js';
import { scanProject, type ScannedFile } from '../project/scan.js';
import { redact } from '../security/redact.js';
import { FileIndexer } from './file-indexer.js';
import type { FileRecord } from '../shared/types.js';
import { rebuildRelations } from './rebuild-relations.js';
import { embedPending } from './embed-pending.js';
import { withWriter, type Progress } from './writer.js';

export const CHECKPOINT_KEY = 'last_index_path';
const RELATIONS_PENDING_KEY = 'relations_rebuild_pending';
const DEFAULT_CONCURRENCY = 20;
const DEFAULT_EMBED_BATCH = 96;
const DEFAULT_EMBED_CONCURRENCY = 2;

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

export interface SyncOptions { force?: string[]; kind?: string; mode?: 'structural' | 'full'; jobId?: string }

export async function syncProject(ctx: MemoryContext, opts: SyncOptions = {}): Promise<SyncReport> {
  return withWriter(ctx, opts.kind === 'init' ? 'init' : 'sync', (progress) => runSync(ctx, opts, progress),
    (r) => r.errors.map((e) => `${e.path}: ${e.message}`).join('\n') || r.semanticError, opts.jobId);
}

async function runSync(ctx: MemoryContext, opts: SyncOptions, progress: Progress): Promise<SyncReport> {
  const { manifest } = ctx;
  progress({ stage: 'scanning', processed: 0, total: 0 });
  await ctx.typesense.ensureCollection();
  const force = new Set(opts.force ?? []);
  for (const error of manifest.errors(Number.MAX_SAFE_INTEGER)) force.add(error.path);
  const changes = detectChanges(ctx, force);
  if (changes.added.length || changes.removed.length) manifest.setMeta(RELATIONS_PENDING_KEY, '1');
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
  const queue = [...changes.added, ...changes.changed].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  // The cursor is diagnostic only: the manifest records successful writes, not path order.
  const pending = queue;
  let checkpointBlocked = false;
  const concurrency = Math.max(1, ctx.config.indexConcurrency ?? DEFAULT_CONCURRENCY);
  const indexOne = async (f: ScannedFile): Promise<void> => {
    try {
      await indexer.index(f);
    } catch (e) {
      const message = redact((e as Error).message);
      manifest.recordError(f.relativePath, message);
      report.errors.push({ path: f.relativePath, message });
    }
  };
  for (let i = 0; i < pending.length; i += concurrency) {
    progress({ stage: 'indexing', processed: i, total: pending.length });
    const batch = pending.slice(i, i + concurrency);
    const errorsBefore = report.errors.length;
    const outcomes = await Promise.allSettled(batch.map(indexOne));
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    if (report.errors.length > errorsBefore) checkpointBlocked = true;
    if (!checkpointBlocked) manifest.setMeta(CHECKPOINT_KEY, batch[batch.length - 1].relativePath);
  }
  if (!report.errors.length) manifest.setMeta(CHECKPOINT_KEY, '');
  progress({ stage: 'indexing', processed: pending.length, total: pending.length });
  const embedding = opts.mode === 'structural' ? { status: 'unknown' as const, error: '' } : await embedPending(ctx, {
    batchSize: ctx.config.embedBatchSize ?? DEFAULT_EMBED_BATCH,
    concurrency: ctx.config.embedConcurrency ?? DEFAULT_EMBED_CONCURRENCY,
    progress,
  });
  if (manifest.getMeta(RELATIONS_PENDING_KEY) === '1') {
    rebuildRelations(ctx);
    manifest.setMeta(RELATIONS_PENDING_KEY, '');
  }
  report.semantic = embedding.status;
  report.semanticError = embedding.error;
  manifest.finishRun(runId, report.added.length + report.changed.length, report.removed.length, report.errors.length);
  return report;
}
