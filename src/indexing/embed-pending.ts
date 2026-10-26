import type { MemoryContext } from '../shared/context.js';
import { redact } from '../security/redact.js';
import type { PendingChunk } from '../storage/manifest.js';
import { toPayload } from './file-indexer.js';
import type { Progress } from './writer.js';

export interface EmbedPendingOptions { batchSize: number; concurrency: number; progress?: Progress }
export interface EmbedPendingResult { embedded: number; status: 'ok' | 'unavailable'; error: string }

const textOf = (c: PendingChunk): string => `${c.relativePath}\n${c.symbol}\n${c.content}`.slice(0, 6000);

export const EMBED_CHECKPOINT_KEY = 'last_embed_path';

/** Embeds all chunks with embedded = 0 in shared batches across files. A failure keeps them pending for the next sync. */
export async function embedPending(ctx: MemoryContext, opts: EmbedPendingOptions): Promise<EmbedPendingResult> {
  const { manifest, embeddings, qdrant, logger, config } = ctx;
  const batchSize = Math.max(1, opts.batchSize);
  const concurrency = Math.max(1, opts.concurrency);
  let embedded = 0;
  const total = manifest.pendingEmbeddings();
  opts.progress?.({ stage: 'embedding', processed: embedded, total });
  let collection: Promise<void> | undefined;
  const ensure = (size: number): Promise<void> => {
    if (!collection) collection = qdrant.ensureCollection(size);
    return collection;
  };

  try {
    for (;;) {
      const round = manifest.unembeddedChunks(batchSize * concurrency);
      if (!round.length) break;
      const batches: PendingChunk[][] = [];
      for (let i = 0; i < round.length; i += batchSize) batches.push(round.slice(i, i + batchSize));
      const results = await Promise.allSettled(batches.map(async (batch) => {
        const vectors = await embeddings.embedBatch(batch.map(textOf));
        await ensure(vectors[0].length);
        await qdrant.upsert(batch.map((c, i) => ({
          chunkId: c.chunkId, vector: vectors[i],
          payload: toPayload(config.projectId, { id: c.fileId, relativePath: c.relativePath, language: c.language, gitCommit: c.gitCommit, indexedAt: c.indexedAt }, c, c.summary),
        })));
        manifest.markChunksEmbedded(batch.map((c) => c.chunkId));
        manifest.setMeta(EMBED_CHECKPOINT_KEY, batch[batch.length - 1].relativePath);
        embedded += batch.length;
        opts.progress?.({ stage: 'embedding', processed: embedded, total });
      }));
      const failure = results.find((r) => r.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
    manifest.setMeta(EMBED_CHECKPOINT_KEY, '');
    return { embedded, status: 'ok', error: '' };
  } catch (e) {
    const error = redact((e as Error).message);
    logger.warn(`semantic_search_unavailable: ${error}`);
    return { embedded, status: 'unavailable', error };
  }
}
