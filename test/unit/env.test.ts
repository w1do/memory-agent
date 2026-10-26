import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureEnvFile, envPath, readEnvFile } from '../../src/project/config.js';
import { scaffold } from '../../src/cli/scaffold.js';

describe('.env preservation', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pm-env-'));
    vi.stubEnv('PROJECT_MEMORY_HOME', join(root, 'home'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('creates .env with a Typesense key when missing', () => {
    ensureEnvFile(root);
    const env = readEnvFile(root);
    expect(env.TYPESENSE_API_KEY).toMatch(/^[0-9a-f]{48}$/);
    expect(env.EMBEDDING_API_KEY).toBe('');
  });

  it('does not overwrite an existing embedding key or Typesense key', () => {
    mkdirSync(join(root, '.memory'), { recursive: true });
    writeFileSync(envPath(root), 'TYPESENSE_API_KEY=keep-me\nEMBEDDING_API_KEY=polza-secret\n');
    ensureEnvFile(root);
    const env = readEnvFile(root);
    expect(env.TYPESENSE_API_KEY).toBe('keep-me');
    expect(env.EMBEDDING_API_KEY).toBe('polza-secret');
  });

  it('appends only missing keys and keeps custom lines', () => {
    mkdirSync(join(root, '.memory'), { recursive: true });
    writeFileSync(envPath(root), '# my note\nEMBEDDING_API_KEY=polza-secret');
    ensureEnvFile(root);
    const text = readFileSync(envPath(root), 'utf8');
    expect(text.startsWith('# my note\nEMBEDDING_API_KEY=polza-secret\n')).toBe(true);
    expect(readEnvFile(root).EMBEDDING_API_KEY).toBe('polza-secret');
    expect(readEnvFile(root).TYPESENSE_API_KEY).toMatch(/^[0-9a-f]{48}$/);
  });

  it('keeps the same .env across repeated scaffold runs (shared service)', async () => {
    mkdirSync(join(root, '.memory'), { recursive: true });
    writeFileSync(envPath(root), '# custom settings\nTYPESENSE_API_KEY=keep-me\nEMBEDDING_API_KEY=polza-secret\n');
    const before = readFileSync(envPath(root), 'utf8');
    await scaffold(root);
    await scaffold(root);
    expect(readFileSync(envPath(root), 'utf8')).toBe(before);
    expect(readEnvFile(root).EMBEDDING_API_KEY).toBe('polza-secret');
  });
});
