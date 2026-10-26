import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scaffold } from '../../src/cli/scaffold.js';
import { createDefaultConfig, loadConfig, saveConfig } from '../../src/project/config.js';
import { renderCompose } from '../../src/cli/compose.js';
import { openJobManifest } from '../../src/indexing/job-manifest.js';
import { acquireJob, finishJob } from '../../src/indexing/job-state.js';

const hooks = vi.hoisted(() => ({ beforeRename: undefined as ((from: string, to: string) => void) | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn<typeof actual.renameSync>((from, to) => {
    hooks.beforeRename?.(String(from), String(to));
    return actual.renameSync(from, to);
  }) };
});
// These tests exercise config publication, without needing any credentials or env files.
vi.mock('../../src/project/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/project/config.js')>();
  return { ...actual, createDefaultConfig: vi.fn(actual.createDefaultConfig), ensureEnvFile: vi.fn() };
});

let root: string;
let home: string;
let compose: string;
beforeEach(async () => {
  root = fs.mkdtempSync(join(tmpdir(), 'pm-scaffold-'));
  home = fs.mkdtempSync(join(tmpdir(), 'pm-scaffold-home-'));
  vi.stubEnv('PROJECT_MEMORY_HOME', home);
  const config = await createDefaultConfig(root, { qdrant: 6333, typesense: 8108 });
  saveConfig(config);
  compose = join(root, '.memory', 'docker-compose.yml');
  fs.writeFileSync(compose, '# existing complete compose\n');
  hooks.beforeRename = undefined;
});
afterEach(() => {
  hooks.beforeRename = undefined; vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
describe('atomic scaffold publication', () => {
  it('keeps the old compose readable until a complete temp file is renamed in the same directory', async () => {
    let published = false;
    const before = fs.readFileSync(compose, 'utf8');
    hooks.beforeRename = (from, to) => {
      if (to !== compose) return;
      expect(dirname(from)).toBe(dirname(to));
      expect(from).not.toBe(to);
      expect(fs.readFileSync(compose, 'utf8')).toBe(before);
      expect(fs.readFileSync(from, 'utf8')).toContain('services:');
      published = true;
    };
    const config = await scaffold(root);
    const user = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid?.()}` : undefined;
    expect(published).toBe(true);
    expect(fs.readFileSync(compose, 'utf8')).toBe(renderCompose(config, user));
    expect(fs.readdirSync(dirname(compose)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
  it('preserves the old compose and removes the temp file when rename fails', async () => {
    const before = fs.readFileSync(compose, 'utf8');
    hooks.beforeRename = (_from, to) => { if (to === compose) throw new Error('rename failed'); };
    await expect(scaffold(root)).rejects.toThrow('rename failed');
    expect(fs.readFileSync(compose, 'utf8')).toBe(before);
    expect(fs.readdirSync(dirname(compose)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
  it('reloads config if another init creates it and starts a job while defaults are being prepared', async () => {
    const config = loadConfig(root);
    const configFile = join(root, '.memory', 'config.json');
    const beforeConfig = fs.readFileSync(configFile, 'utf8');
    const beforeCompose = fs.readFileSync(compose, 'utf8');
    fs.unlinkSync(configFile);
    vi.mocked(createDefaultConfig).mockImplementationOnce(async () => {
      saveConfig(config);
      const manifest = openJobManifest(root);
      try { acquireJob(manifest, root, 'init'); } finally { manifest.close(); }
      return { ...config, qdrantPort: 9999 };
    });
    expect(await scaffold(root)).toEqual(config);
    expect(fs.readFileSync(configFile, 'utf8')).toBe(beforeConfig);
    expect(fs.readFileSync(compose, 'utf8')).toBe(beforeCompose);
  });
  it.each(['init', 'sync'] as const)('preserves config files during an active %s job, then allows scaffold after completion', async (operation) => {
    const manifest = openJobManifest(root);
    try {
      const { job } = acquireJob(manifest, root, operation);
      const configPath = join(root, '.memory', 'config.json');
      const beforeConfig = fs.readFileSync(configPath, 'utf8');
      const beforeCompose = fs.readFileSync(compose, 'utf8');
      const beforeStat = fs.statSync(compose);
      await scaffold(root);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(beforeConfig);
      expect(fs.readFileSync(compose, 'utf8')).toBe(beforeCompose);
      expect(fs.statSync(compose).ino).toBe(beforeStat.ino);
      expect(fs.existsSync(join(root, '.memory', 'mcp.example.json'))).toBe(false);
      finishJob(manifest, job.id);
      await scaffold(root);
      expect(fs.readFileSync(compose, 'utf8')).toContain('services:');
    } finally { manifest.close(); }
  });
});
