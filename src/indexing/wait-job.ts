import { jobStatus } from './job-manifest.js';
import { isActive, type IndexJob } from './job-state.js';

export async function waitJob(root: string, id: string): Promise<IndexJob> {
  for (;;) {
    const job = jobStatus(root, id);
    if (!isActive(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
