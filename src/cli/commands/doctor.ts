import { existsSync } from 'node:fs';
import { rootFrom } from '../common.js';
import { dockerAvailable, servicesState } from '../docker.js';
import { configPath } from '../../project/config.js';
import { openContext } from '../../shared/context.js';
import { getStatus } from '../../project/status.js';
import { legacyHint } from './migrate.js';
import { globalDir } from '../../global/paths.js';
import { serviceStatus } from '../../global/service.js';
import { assertSharedServiceUp, isLegacyProject } from '../../global/shared-mode.js';
import { gitRoot } from '../../project/git.js';

type Check = { name: string; ok: boolean; detail: string; required: boolean };

export async function doctorCommand(o: { path?: string }): Promise<void> {
  const root = rootFrom(o.path);
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, required = true) => checks.push({ name, ok, detail, required });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 22, `v${process.versions.node} (need >= 22.13)`);
  const docker = dockerAvailable();
  add('docker compose', docker.ok, docker.ok ? docker.output.split('\n')[0] : docker.output.slice(0, 200));
  add('git repository', !!gitRoot(root), gitRoot(root) || 'not a git repository (optional)', false);

  if (!existsSync(configPath(root))) {
    add('project', false, `not initialised in ${root}; run "memory init"`, false);
  } else {
    const hint = legacyHint(root);
    if (hint) add('shared service', false, hint, false);
    else {
      const up = await assertSharedServiceUp().then(() => true, () => false);
      add('shared service', up, up ? `running (config ${globalDir()}/global.env)` : 'not running; run "memory service up"');
    }
    const ctx = openContext(root, { quiet: true });
    try {
      const s = await getStatus(ctx);
      if (docker.ok) {
        const st = isLegacyProject(root) ? servicesState(root) : serviceStatus();
        add('containers', true, st.output.replace(/\n/g, '; ') || 'none running', false);
      }
      add('qdrant', s.qdrant.ok, `${s.qdrant.detail}${s.qdrant.count !== undefined ? `, ${s.qdrant.count} points` : ''}`);
      add('typesense', s.typesense.ok, `${s.typesense.detail}${s.typesense.count !== undefined ? `, ${s.typesense.count} documents` : ''}`);
      add('embeddings', s.embeddings.ok, `${s.embeddings.detail} (optional: lexical mode works without)`, false);
      add('manifest', true, `${s.files} files, ${s.chunks} chunks, ${s.errors} errors, last sync ${s.last_sync_at ?? 'never'}`);
      add('freshness', s.stale_files === 0 && s.unindexed_files === 0, `${s.stale_files} stale, ${s.unindexed_files} unindexed`, false);
      add('search mode', s.search_mode !== 'unavailable', s.search_mode);
    } finally { ctx.close(); }
  }
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : c.required ? 'FAIL' : 'warn'} ${c.name}: ${c.detail}`);
  if (checks.some((c) => c.required && !c.ok)) process.exitCode = 1;
}
