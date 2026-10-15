import { join } from 'node:path';
import { rootFrom, printSync } from '../common.js';
import { mcpExample, scaffold } from '../scaffold.js';
import { dockerAvailable, startServices } from '../docker.js';
import { openContext } from '../../shared/context.js';
import { syncProject } from '../../indexing/sync.js';
import { searchMemory } from '../../search/hybrid.js';
import { MemoryError } from '../../shared/errors.js';
import { memoryDir } from '../../project/config.js';
import { assertSharedServiceUp, isLegacyProject } from '../../global/shared-mode.js';

export interface InitOptions { path?: string; start: boolean; index: boolean; yes?: boolean }

export async function initCommand(opts: InitOptions): Promise<void> {
  const root = rootFrom(opts.path);
  console.log(`Project root: ${root}`);
  const config = await scaffold(root);
  console.log(`Created/verified ${join(memoryDir(root), '')} (collection "${config.collection}")`);

  if (opts.start) {
    if (isLegacyProject(root)) {
      if (!dockerAvailable().ok) throw new MemoryError('Docker Compose is not available. Install Docker or use --no-start.', 'docker_missing');
      console.log('Starting Qdrant and Typesense (docker compose)...');
      startServices(root);
    } else {
      await assertSharedServiceUp();
      console.log('Using shared Qdrant and Typesense (no containers started).');
    }
  }
  if (opts.start && opts.index) {
    const ctx = openContext(root);
    try {
      await ctx.typesense.ensureCollection();
      console.log('Typesense collection ready. Indexing…');
      printSync(await syncProject(ctx, { kind: 'init' }));
      const probe = await searchMemory(ctx, { query: config.projectName, mode: 'lexical', limit: 3, include_snippets: false });
      console.log(`Test search: ${probe.hits.length} hit(s)`);
      probe.warnings.forEach((w) => console.log(`  ${w}`));
    } finally { ctx.close(); }
  }
  console.log('\nMCP client config (also saved to .memory/mcp.example.json):');
  console.log(JSON.stringify(mcpExample(root), null, 2));
  console.log('\nSemantic search: put your Polza.AI key into EMBEDDING_API_KEY in ~/.config/project-memory/global.env (default: https://polza.ai/api/v1, openai/text-embedding-3-small)');
}
