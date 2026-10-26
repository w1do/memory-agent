import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGlobalEnv, parseEnv } from '../../src/global/env.js';
import { globalEnvPath, indexDbPath } from '../../src/global/paths.js';
import { renderSharedCompose } from '../../src/global/compose.js';

let home: string;
const previous = process.env.PROJECT_MEMORY_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pm-global-'));
  process.env.PROJECT_MEMORY_HOME = home;
});

afterEach(() => {
  if (previous === undefined) delete process.env.PROJECT_MEMORY_HOME;
  else process.env.PROJECT_MEMORY_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

describe('global.env', () => {
  it('creates the file once with a generated Typesense key and mode 600', () => {
    const first = ensureGlobalEnv();
    expect(first.TYPESENSE_API_KEY).toMatch(/^[0-9a-f]{48}$/);
    expect(statSync(globalEnvPath()).mode & 0o777).toBe(0o600);
  });

  it('is idempotent: a second call keeps the same key and values', () => {
    const first = ensureGlobalEnv();
    const second = ensureGlobalEnv();
    expect(second.TYPESENSE_API_KEY).toBe(first.TYPESENSE_API_KEY);
    expect(readFileSync(globalEnvPath(), 'utf8').match(/TYPESENSE_API_KEY=/g)).toHaveLength(1);
  });

  it('appends only missing keys and never overwrites user values', () => {
    writeFileSync(globalEnvPath(), 'EMBEDDING_API_KEY=secret-value\nTYPESENSE_API_KEY=mine');
    const env = ensureGlobalEnv();
    expect(env.EMBEDDING_API_KEY).toBe('secret-value');
    expect(env.TYPESENSE_API_KEY).toBe('mine');
    expect(env.EMBEDDING_MODEL).toBe('openai/text-embedding-3-small');
  });

  it('parses KEY=VALUE lines and ignores comments', () => {
    expect(parseEnv('# note\nA=1\n  B = two \n')).toEqual({ A: '1', B: 'two' });
  });
});

describe('global paths and shared compose', () => {
  it('stores each project index under the global dir keyed by projectId', () => {
    expect(indexDbPath('demo-abc123')).toBe(join(home, 'index', 'demo-abc123', 'index.db'));
  });

  it('binds shared services to loopback and reads the key from global.env', () => {
    const yaml = renderSharedCompose(parseEnv('QDRANT_PORT=7333\nTYPESENSE_PORT=9108'));
    expect(yaml).toContain('"127.0.0.1:7333:6333"');
    expect(yaml).toContain('"127.0.0.1:9108:8108"');
    expect(yaml).toContain('global.env');
    expect(yaml).not.toMatch(/0\.0\.0\.0/);
  });

  it('raises the Typesense open-file limit above the Docker default', () => {
    const yaml = renderSharedCompose(parseEnv(''));
    expect(yaml).toContain('ulimits:\n      nofile:\n        soft: 65536\n        hard: 65536');
  });
});

describe('index location', () => {
  it('copies a legacy project index.db into the global dir once', async () => {
    const { resolveIndexDb } = await import('../../src/global/index-location.js');
    const { mkdirSync, existsSync } = await import('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'pm-proj-'));
    mkdirSync(join(root, '.memory'));
    writeFileSync(join(root, '.memory', 'index.db'), 'legacy');
    const target = resolveIndexDb(root, 'demo-1');
    expect(target).toBe(indexDbPath('demo-1'));
    expect(readFileSync(target, 'utf8')).toBe('legacy');
    writeFileSync(target, 'changed');
    resolveIndexDb(root, 'demo-1');
    expect(readFileSync(target, 'utf8')).toBe('changed');
    expect(existsSync(join(root, '.memory', 'index.db'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
