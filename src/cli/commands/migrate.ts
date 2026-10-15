import { resolve } from 'node:path';
import { rootFrom } from '../common.js';
import { cleanupLeftovers, migrateProject, rollbackProject, scanLegacy } from '../../global/migrate.js';
import { listProjects } from '../../global/registry.js';
import { isLegacyProject } from '../../global/shared-mode.js';

export interface MigrateOptions { path?: string; scan?: string; apply?: boolean; cleanup?: boolean; all?: boolean; rollback?: boolean }

export async function migrateCommand(o: MigrateOptions): Promise<void> {
  if (o.rollback) {
    const r = rollbackProject(rootFrom(o.path));
    console.log(`${r.status.padEnd(8)} ${r.root}  ${r.detail}`);
    if (r.status === 'error') process.exitCode = 1;
    return;
  }
  const roots = o.scan ? scanLegacy(resolve(o.scan)) : o.all ? listProjects().filter(isLegacyProject) : [rootFrom(o.path)];
  if (o.scan && !o.apply) {
    roots.forEach((r) => console.log(`legacy: ${r}`));
    console.log(`${roots.length} project(s) found. Add --apply to migrate them.`);
    return;
  }
  const results = [];
  for (const root of roots) {
    const r = await migrateProject(root);
    console.log(`${r.status.padEnd(8)} ${r.root}  ${r.detail}`);
    results.push(r);
    if (o.cleanup && r.status !== 'error' && !isLegacyProject(root)) {
      const removed = cleanupLeftovers(root);
      console.log(removed.length ? `cleaned  ${root}  removed ${removed.map((p) => p.slice(root.length + 1)).join(', ')}` : `cleaned  ${root}  nothing to remove`);
    }
  }
  if (results.some((r) => r.status === 'error')) process.exitCode = 1;
}

export const legacyHint = (root: string): string | undefined =>
  isLegacyProject(root) ? 'project uses its own Docker stack; run "memory migrate" to move it to the shared service' : undefined;
