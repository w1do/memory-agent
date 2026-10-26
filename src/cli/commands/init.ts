import { join } from 'node:path';
import { rootFrom, printSync } from '../common.js';
import { mcpExample, scaffold } from '../scaffold.js';
import { openContext } from '../../shared/context.js';
import { searchMemory } from '../../search/hybrid.js';
import { MemoryError } from '../../shared/errors.js';
import { memoryDir } from '../../project/config.js';
import { prepareInitServices } from './init-services.js';
import { launchJob } from '../../indexing/background.js';
import { waitJob } from '../../indexing/wait-job.js';
import type { SyncReport } from '../../indexing/sync.js';

export interface InitOptions { path?: string; start: boolean; index: boolean; yes?: boolean; wait?: boolean }

export async function initCommand(opts: InitOptions): Promise<void> {
  const root = rootFrom(opts.path);
  console.log(`Project root: ${root}`);
  const config = await scaffold(root);
  console.log(`Created/verified ${join(memoryDir(root), '')} (collection "${config.collection}")`);

  if (opts.start && opts.index) {
    const reply = await launchJob(root, 'init');
    console.log(JSON.stringify(reply));
    if (reply.status === 'busy') {
      throw Object.assign(new MemoryError(`Index writer is busy (${reply.job_id})`, 'busy'), { job_id: reply.job_id });
    }
    if (opts.wait && reply.status === 'accepted') {
      const job = await waitJob(root, reply.job_id);
      console.log(JSON.stringify(job));
      if (job.result) printSync(job.result as SyncReport);
      if (job.state !== 'completed') throw new MemoryError(job.error, 'init_failed');
      const ctx = openContext(root);
      try {
        const probe = await searchMemory(ctx, { query: config.projectName, mode: 'lexical', limit: 3, include_snippets: false });
        console.log(`Test search: ${probe.hits.length} hit(s)`);
        probe.warnings.forEach((w) => console.log(`  ${w}`));
      } finally { ctx.close(); }
    }
  } else if (opts.start) await prepareInitServices(root);
  console.log('\nMCP client config (also saved to .memory/mcp.example.json):');
  console.log(JSON.stringify(mcpExample(root), null, 2));
  console.log('\nSemantic search: put your Polza.AI key into EMBEDDING_API_KEY in ~/.config/project-memory/global.env (default: https://polza.ai/api/v1, openai/text-embedding-3-small)');
}
