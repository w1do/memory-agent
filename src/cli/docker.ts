import { spawnSync } from 'node:child_process';

export interface Run { ok: boolean; output: string }

const run = (args: string[], cwd: string): Run => {
  const r = spawnSync('docker', args, { cwd, encoding: 'utf8', timeout: 600_000 });
  if (r.error) return { ok: false, output: r.error.message };
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

export const dockerAvailable = (): Run => run(['compose', 'version'], process.cwd());
