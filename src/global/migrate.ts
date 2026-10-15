import { cpSync, existsSync, statSync, readdirSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, memoryDir, readEnvFile, saveConfig, envPath } from '../project/config.js';
import { startServices, stopServices } from '../cli/docker.js';
import { openContext } from '../shared/context.js';
import { syncProject } from '../indexing/sync.js';
import { ensureGlobalEnv } from './env.js';
import { globalEnvPath } from './paths.js';
import { registerProject } from './registry.js';
import { assertSharedServiceUp, isLegacyProject, sharedPorts } from './shared-mode.js';

export type MigrateStatus = 'migrated' | 'skipped' | 'error';
export interface MigrateResult { root: string; status: MigrateStatus; detail: string }

const COMPOSE = 'docker-compose.yml';

/** Moves one legacy project to the shared service. Idempotent: a migrated project is skipped. */
export async function migrateProject(root: string, opts: { cleanup?: boolean } = {}): Promise<MigrateResult> {
  if (!isLegacyProject(root)) return { root, status: 'skipped', detail: 'already on shared service' };
  try {
    await assertSharedServiceUp();
    const cfg = loadConfig(root);
    const globalEnv = ensureGlobalEnv();
    const projDims = Number(readEnvFile(root).EMBEDDING_DIMENSIONS || cfg.embedding.dimensions);
    const sharedDims = Number(globalEnv.EMBEDDING_DIMENSIONS || 1536);
    if (projDims !== sharedDims) {
      return { root, status: 'error', detail: `embedding dimensions differ (project ${projDims}, shared ${sharedDims}); migration skipped, nothing changed` };
    }
    const dir = memoryDir(root);
    const backup = join(root, `.memory.bak-${new Date().toISOString().slice(0, 10)}`);
    mkdirSync(backup, { recursive: true });
    for (const f of readdirSync(dir)) if (f !== 'data') cpSync(join(dir, f), join(backup, f), { recursive: true });
    stopServices(root);
    const env = readEnvFile(root);
    const global = ensureGlobalEnv();
    const fill = Object.entries(env).filter(([k, v]) => k.startsWith('EMBEDDING_') && v !== '' && !global[k]);
    if (fill.length) writeFileSync(globalEnvPath(), `${fill.map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { flag: 'a' });
    const ports = sharedPorts();
    saveConfig({ ...loadConfig(root), qdrantPort: ports.qdrant, typesensePort: ports.typesense });
    if (existsSync(envPath(root))) rmSync(envPath(root));
    renameSync(join(dir, COMPOSE), join(dir, `${COMPOSE}.old`));
    const ctx = openContext(root, { quiet: true });
    try {
      await ctx.typesense.ensureCollection();
      await syncProject(ctx, { kind: 'reindex', force: ctx.manifest.listFiles().map((f) => f.relativePath) });
    } finally { ctx.close(); }
    if (opts.cleanup) { rmSync(join(dir, 'data'), { recursive: true, force: true }); rmSync(join(dir, `${COMPOSE}.old`), { force: true }); }
    registerProject(root);
    return { root, status: 'migrated', detail: `backup ${backup}` };
  } catch (e) {
    return { root, status: 'error', detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Finds directories that contain a legacy .memory under base (skips node_modules and dot dirs). */
export function scanLegacy(base: string, depth = 4): string[] {
  const found: string[] = [];
  const walk = (d: string, left: number): void => {
    if (isLegacyProject(d)) found.push(d);
    if (left === 0) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) walk(join(d, e.name), left - 1);
    }
  };
  walk(base, depth);
  return found;
}

/** Restores the newest .memory.bak-* and restarts the old per-project stack. */
export function rollbackProject(root: string): MigrateResult {
  try {
    const backups = readdirSync(root).filter((n) => n.startsWith('.memory.bak-') && statSync(join(root, n)).isDirectory()).sort();
    const latest = backups[backups.length - 1];
    if (!latest) return { root, status: 'skipped', detail: 'no backup found' };
    const dir = memoryDir(root);
    cpSync(join(root, latest), dir, { recursive: true });
    const old = join(dir, `${COMPOSE}.old`);
    if (existsSync(old) && !existsSync(join(dir, COMPOSE))) renameSync(old, join(dir, COMPOSE));
    if (!existsSync(join(dir, COMPOSE))) return { root, status: 'error', detail: 'backup has no docker-compose.yml' };
    startServices(root);
    return { root, status: 'migrated', detail: `restored from ${latest}` };
  } catch (e) {
    return { root, status: 'error', detail: e instanceof Error ? e.message : String(e) };
  }
}
