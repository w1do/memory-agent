import { loadConfig } from '../project/config.js';
import { resolveIndexDb } from '../global/index-location.js';
import { Manifest } from '../storage/manifest.js';
import { getJob, type IndexJob } from './job-state.js';

/** Job polling deliberately avoids opening clients, importing annotations, and loading matchers. */
export function openJobManifest(root: string): Manifest {
  return new Manifest(resolveIndexDb(root, loadConfig(root).projectId));
}
export function jobStatus(root: string, id: string): IndexJob {
  const manifest = openJobManifest(root);
  try { return getJob(manifest, id); } finally { manifest.close(); }
}
