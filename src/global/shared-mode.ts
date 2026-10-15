import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { memoryDir, type EnvMap } from '../project/config.js';
import { ensureGlobalEnv, readGlobalEnv } from './env.js';
import { MemoryError } from '../shared/errors.js';

/** A project with its own docker-compose.yml still uses per-project services (legacy until migrated). */
export const isLegacyProject = (root: string): boolean => existsSync(join(memoryDir(root), 'docker-compose.yml'));

export const sharedPorts = (): { qdrant: number; typesense: number } => {
  const env = ensureGlobalEnv();
  return { qdrant: Number(env.QDRANT_PORT ?? 6333), typesense: Number(env.TYPESENSE_PORT ?? 8108) };
};

/** Global values first, project .env overrides only non-empty values. */
export function mergeEnv(project: EnvMap): EnvMap {
  const merged: EnvMap = { ...readGlobalEnv() };
  for (const [k, v] of Object.entries(project)) if (v !== '') merged[k] = v;
  return merged;
}

export async function assertSharedServiceUp(): Promise<void> {
  const { qdrant } = sharedPorts();
  let detail = '';
  try {
    const res = await fetch(`http://127.0.0.1:${qdrant}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return;
    detail = `HTTP ${res.status}`;
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    detail = err.cause?.code ?? err.cause?.message ?? err.message;
  }
  throw new MemoryError(`Shared service is not reachable at 127.0.0.1:${qdrant} (${detail}). Run "memory service up" once, then retry.`, 'service_down');
}
