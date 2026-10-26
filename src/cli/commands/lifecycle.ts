import { rootFrom, withContext } from '../common.js';
import { startServices, stopServices } from '../docker.js';
import { getStatus } from '../../project/status.js';
import { jobStatus } from '../../indexing/job-manifest.js';

export const startCommand = (o: { path?: string }) => { startServices(rootFrom(o.path)); console.log('Services are healthy.'); };
export const stopCommand = (o: { path?: string }) => { stopServices(rootFrom(o.path)); console.log('Services stopped (data kept in .memory/data).'); };

export async function statusCommand(o: { path?: string; json?: boolean; job?: string }): Promise<void> {
  if (o.job) { console.log(JSON.stringify(jobStatus(rootFrom(o.path), o.job), null, 2)); return; }
  await withContext(o.path, async (ctx) => {
    const s = await getStatus(ctx);
    if (o.json) return console.log(JSON.stringify(s, null, 2));
    const line = (n: string, v: { ok: boolean; detail: string; count?: number }) =>
      console.log(`${v.ok ? 'ok  ' : 'FAIL'} ${n}: ${v.detail}${v.count !== undefined ? `, ${v.count} points` : ''}`);
    console.log(`Project ${s.project} (collection ${s.collection})`);
    line('qdrant', s.qdrant); line('typesense', s.typesense); line('embeddings', s.embeddings);
    console.log(`files ${s.files}, chunks ${s.chunks}, errors ${s.errors}, stale ${s.stale_files}, unindexed ${s.unindexed_files}`);
    console.log(`pending embeddings: ${s.pending_embeddings}`);
    console.log(`last sync: ${s.last_sync_at ?? 'never'}; search mode: ${s.search_mode}`);
    console.log(`last file: ${s.last_path.embedding ?? 'none'}`);
    console.log(`last_path: indexing ${s.last_path.indexing ?? 'null'}, embedding ${s.last_path.embedding ?? 'null'}`);
  });
}
