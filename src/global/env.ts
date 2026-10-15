import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { globalDir, globalEnvPath } from './paths.js';

export type GlobalEnv = Record<string, string>;

export const GLOBAL_ENV_DEFAULTS: Array<[string, string]> = [
  ['TYPESENSE_API_KEY', ''],
  ['EMBEDDING_BASE_URL', 'https://polza.ai/api/v1'],
  ['EMBEDDING_API_KEY', ''],
  ['EMBEDDING_MODEL', 'openai/text-embedding-3-small'],
  ['EMBEDDING_DIMENSIONS', '1536'],
  ['QDRANT_PORT', '6333'],
  ['TYPESENSE_PORT', '8108'],
];

export function parseEnv(text: string): GlobalEnv {
  const out: GlobalEnv = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function readGlobalEnv(): GlobalEnv {
  return existsSync(globalEnvPath()) ? parseEnv(readFileSync(globalEnvPath(), 'utf8')) : {};
}

/**
 * Creates global.env once with a generated Typesense key; later calls only append missing keys
 * and never change existing values. The file is always kept at mode 600.
 */
export function ensureGlobalEnv(): GlobalEnv {
  mkdirSync(globalDir(), { recursive: true });
  const defaults: Array<[string, string]> = GLOBAL_ENV_DEFAULTS.map(([key, value]) =>
    key === 'TYPESENSE_API_KEY' ? [key, randomBytes(24).toString('hex')] : [key, value],
  );
  if (!existsSync(globalEnvPath())) {
    writeFileSync(globalEnvPath(), defaults.map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  } else {
    const present = readGlobalEnv();
    const missing = defaults.filter(([key]) => !(key in present));
    if (missing.length) {
      const current = readFileSync(globalEnvPath(), 'utf8');
      const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
      writeFileSync(globalEnvPath(), current + separator + missing.map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    }
  }
  chmodSync(globalEnvPath(), 0o600);
  return readGlobalEnv();
}
