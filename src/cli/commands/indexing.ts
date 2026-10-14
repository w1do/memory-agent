import chokidar from 'chokidar';
import { relative } from 'node:path';
import { rootFrom, withContext, printSync } from '../common.js';
import { syncProject } from '../../indexing/sync.js';
import { updatePaths } from '../../indexing/update.js';
import { openContext } from '../../shared/context.js';
import { toPosix } from '../../project/paths.js';

type P = { path?: string };

export const syncCommand = (o: P, kind = 'sync') => withContext(o.path, async (ctx) => printSync(await syncProject(ctx, { kind })));

export const reindexCommand = (o: P, paths: string[] = []) => withContext(o.path, async (ctx) => {
  if (paths.length) {
    const results = await updatePaths(ctx, paths);
    results.forEach((r) => console.log(`${r.status.padEnd(8)} ${r.path}${r.reason ? `  (${r.reason})` : ''}`));
    const errors = results.filter((r) => r.status === 'error').length;
    console.log(`reindexed ${results.length} path(s), errors ${errors}`);
    return;
  }
  console.log('Re-reading all indexed files. Existing Qdrant and Typesense data is kept; embeddings are created only for new chunks.');
  const known = ctx.manifest.listFiles().map((f) => f.relativePath);
  printSync(await syncProject(ctx, { kind: 'reindex', force: known }));
});

const DEBOUNCE_MS = 500;

export async function watchCommand(o: P): Promise<void> {
  const root = rootFrom(o.path);
  const ctx = openContext(root);
  await ctx.typesense.ensureCollection();
  printSync(await syncProject(ctx, { kind: 'watch-initial' }));
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let busy = false;

  const flush = async (): Promise<void> => {
    if (busy) { timer = setTimeout(flush, DEBOUNCE_MS); return; }
    busy = true;
    const paths = [...pending]; pending.clear();
    try {
      const results = await updatePaths(ctx, paths);
      results.filter((r) => r.status !== 'skipped').forEach((r) => ctx.logger.info(`watch: ${r.status} ${r.path}`));
    } catch (e) { ctx.logger.error(`watch update failed: ${(e as Error).message}`); }
    busy = false;
  };

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (p) => {
      const rel = toPosix(relative(root, p));
      return !!rel && !rel.startsWith('..') && (ctx.matcher.matches(rel) || ctx.matcher.matches(`${rel}/`) || /(~|\.sw[a-p]|\.tmp|\.#.*)$/.test(rel));
    },
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  watcher.on('all', (_event, p) => {
    pending.add(toPosix(relative(root, p)));
    clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  });
  console.log('Watching for changes. Press Ctrl+C to stop.');
  await new Promise<void>((resolve) => {
    const stop = () => { clearTimeout(timer); void watcher.close().then(() => { ctx.close(); resolve(); }); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
