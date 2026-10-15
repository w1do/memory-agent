import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryError } from '../shared/errors.js';
import { ensureGlobalEnv, readGlobalEnv } from './env.js';
import { globalComposePath, globalDir, globalEnvPath } from './paths.js';
import { renderSharedCompose } from './compose.js';

export interface DockerRun { ok: boolean; output: string }

const dockerCompose = (args: string[]): DockerRun => {
  const r = spawnSync('docker', ['compose', '--env-file', globalEnvPath(), '-f', globalComposePath(), '--project-directory', globalDir(), ...args], {
    encoding: 'utf8', timeout: 600_000,
  });
  if (r.error) return { ok: false, output: r.error.message };
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

export const dockerComposeAvailable = (): boolean =>
  spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

/** Idempotent: writes config once, creates data dirs, then "compose up" (no-op if already healthy). */
export function serviceUp(): void {
  ensureGlobalEnv();
  const user = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid?.()}` : undefined;
  mkdirSync(join(globalDir(), 'data', 'qdrant'), { recursive: true });
  mkdirSync(join(globalDir(), 'data', 'typesense'), { recursive: true });
  writeFileSync(globalComposePath(), renderSharedCompose(readGlobalEnv(), user));
  const r = dockerCompose(['up', '-d', '--wait', '--wait-timeout', '180']);
  if (!r.ok) throw new MemoryError(`docker compose up failed:\n${r.output.slice(-1500)}`, 'docker_failed');
}

export function serviceDown(): void {
  const r = dockerCompose(['down']);
  if (!r.ok) throw new MemoryError(`docker compose down failed:\n${r.output.slice(-1500)}`, 'docker_failed');
}

export const serviceStatus = (): DockerRun => dockerCompose(['ps', '--format', '{{.Service}}: {{.State}} ({{.Health}})']);

export const serviceLogs = (tail = 200): DockerRun => dockerCompose(['logs', '--tail', String(tail)]);
