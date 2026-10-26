import { loadConfig } from '../project/config.js';
import { resolveIndexDb } from '../global/index-location.js';
import { activeGeneration } from '../storage/generation.js';
import { Manifest } from '../storage/manifest.js';
import { getJob, type IndexJob } from './job-state.js';

/** Job polling deliberately avoids opening clients, importing annotations, and loading matchers. */
export function openJobManifest(root: string): Manifest {
  const generation = activeGeneration(root);
  return new Manifest(resolveIndexDb(root, loadConfig(root).projectId, generation ?? null), generation);
}
export function jobStatus(root: string, id: string): IndexJob {
  const manifest = openJobManifest(root);
  try { return getJob(manifest, id); } finally { manifest.close(); }
}
