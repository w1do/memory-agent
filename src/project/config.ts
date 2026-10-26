import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256 } from '../shared/hash.js';
import { MemoryError } from '../shared/errors.js';

export interface MemoryConfig {
  projectId: string;
  projectName: string;
  root: string;
  collection: string;
  host: '127.0.0.1';
  qdrantPort: number;
  typesensePort: number;
  embedding: { baseUrl: string; model: string; dimensions: number };
  maxFileSize: number;
  indexConcurrency?: number;
  embedBatchSize?: number;
  embedConcurrency?: number;
}

export const memoryDir = (root: string) => join(root, '.memory');
export const configPath = (root: string) => join(memoryDir(root), 'config.json');
export const envPath = (root: string) => join(memoryDir(root), '.env');

export const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

/** Collection name: folder slug + short hash of the absolute path (unique per project). */
export const collectionName = (root: string): string =>
  `${slugify(basename(root))}-${sha256(root).slice(0, 6)}`;

export async function freePort(preferred: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number>((ok, fail) => {
      const srv = createServer();
      srv.once('error', fail);
      srv.listen(port, '127.0.0.1', () => {
        const addr = srv.address();
        srv.close(() => ok(typeof addr === 'object' && addr ? addr.port : port));
      });
    });
  try {
    return await tryPort(preferred);
  } catch {
    return tryPort(0);
  }
}

export async function createDefaultConfig(root: string, ports?: { qdrant: number; typesense: number }): Promise<MemoryConfig> {
  const name = collectionName(root);
  return {
    projectId: name,
    projectName: basename(root),
    root,
    collection: name,
    host: '127.0.0.1',
    qdrantPort: ports?.qdrant ?? await freePort(6333),
    typesensePort: ports?.typesense ?? await freePort(8108),
    embedding: { baseUrl: 'https://polza.ai/api/v1', model: 'openai/text-embedding-3-small', dimensions: 1536 },
    maxFileSize: 512 * 1024,
  };
}

export function loadConfig(root: string): MemoryConfig {
  if (!existsSync(configPath(root))) {
    throw new MemoryError(`Project is not initialised: run "memory init" in ${root}`, 'not_initialised');
  }
  return { ...JSON.parse(readFileSync(configPath(root), 'utf8')), root };
}

export function saveConfig(config: MemoryConfig): void {
  mkdirSync(memoryDir(config.root), { recursive: true });
  const target = configPath(config.root);
  const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, target);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export type EnvMap = Record<string, string>;

export function readEnvFile(root: string): EnvMap {
  if (!existsSync(envPath(root))) return {};
  const out: EnvMap = {};
  for (const line of readFileSync(envPath(root), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Creates .env if missing; otherwise keeps every existing line and only appends missing keys. */
export function ensureEnvFile(root: string): void {
  mkdirSync(memoryDir(root), { recursive: true });
  const defaults: Array<[string, string]> = [
    ['TYPESENSE_API_KEY', randomBytes(24).toString('hex')],
    ['EMBEDDING_BASE_URL', ''],
    ['EMBEDDING_API_KEY', ''],
    ['EMBEDDING_MODEL', ''],
  ];
  if (!existsSync(envPath(root))) {
    const lines = defaults.map(([key, value]) => `${key}=${value}`);
    writeFileSync(envPath(root), lines.join('\n') + '\n', { mode: 0o600 });
    return;
  }
  const present = readEnvFile(root);
  const missing = defaults.filter(([key]) => !(key in present));
  if (!missing.length) return;
  const current = readFileSync(envPath(root), 'utf8');
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  appendFileSync(envPath(root), separator + missing.map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
}
