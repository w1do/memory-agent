import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { memoryDir } from '../project/config.js';
import { MemoryError } from '../shared/errors.js';

export interface Run { ok: boolean; output: string }

const run = (args: string[], cwd: string): Run => {
  const r = spawnSync('docker', args, { cwd, encoding: 'utf8', timeout: 600_000 });
  if (r.error) return { ok: false, output: r.error.message };
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

export const dockerAvailable = (): Run => run(['compose', 'version'], process.cwd());

function compose(root: string, args: string[]): Run {
  const dir = memoryDir(root);
  return run(['compose', '-f', join(dir, 'docker-compose.yml'), '--project-directory', dir, ...args], root);
}

export function startServices(root: string): void {
  const r = compose(root, ['up', '-d', '--wait', '--wait-timeout', '180']);
  if (!r.ok) throw new MemoryError(`docker compose up failed:\n${r.output.slice(-1500)}`, 'docker_failed');
}

export function stopServices(root: string): void {
  const r = compose(root, ['down']);
  if (!r.ok) throw new MemoryError(`docker compose down failed:\n${r.output.slice(-1500)}`, 'docker_failed');
}

export const servicesState = (root: string): Run => compose(root, ['ps', '--format', '{{.Service}}: {{.State}} ({{.Health}})']);
