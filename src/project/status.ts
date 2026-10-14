import type { MemoryContext } from '../shared/context.js';
import { checkFreshness } from '../search/freshness.js';
import { CHECKPOINT_KEY } from '../indexing/sync.js';
import { EMBED_CHECKPOINT_KEY } from '../indexing/embed-pending.js';

export interface ServiceStatus { ok: boolean; detail: string; count?: number }

export interface MemoryStatus {
  project: string; collection: string; root: string;
  qdrant: ServiceStatus; typesense: ServiceStatus; embeddings: ServiceStatus;
  files: number; chunks: number; errors: number; last_sync_at: string | null;
  stale_files: number; unindexed_files: number; search_mode: 'hybrid' | 'degraded_lexical' | 'unavailable';
  last_path: { indexing: string | null; embedding: string | null };
}

async function withCount(health: Promise<ServiceStatus>, count: () => Promise<number>): Promise<ServiceStatus> {
  const h = await health;
  if (!h.ok) return h;
  try { return { ...h, count: await count() }; } catch (e) { return { ok: false, detail: (e as Error).message }; }
}

export async function getStatus(ctx: MemoryContext, opts: { checkEmbeddings?: boolean } = {}): Promise<MemoryStatus> {
  const [qdrant, typesense] = await Promise.all([
    withCount(ctx.qdrant.health(), () => ctx.qdrant.count()),
    withCount(ctx.typesense.health(), () => ctx.typesense.count().catch(() => 0)),
  ]);
  const embeddings = opts.checkEmbeddings === false ? { ok: false, detail: 'not checked' } : await ctx.embeddings.health();
  const counts = ctx.manifest.counts();
  const fresh = checkFreshness(ctx);
  return {
    project: ctx.config.projectName, collection: ctx.config.collection, root: ctx.root,
    qdrant, typesense, embeddings, ...counts,
    last_sync_at: ctx.manifest.getMeta('last_sync_at') ?? null,
    stale_files: fresh.stale.size, unindexed_files: fresh.added.length,
    search_mode: !typesense.ok ? 'unavailable' : qdrant.ok && embeddings.ok ? 'hybrid' : 'degraded_lexical',
    last_path: {
      indexing: ctx.manifest.getMeta(CHECKPOINT_KEY) || null,
      embedding: ctx.manifest.getMeta(EMBED_CHECKPOINT_KEY) || null,
    },
  };
}
