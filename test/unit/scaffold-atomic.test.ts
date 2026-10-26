import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold } from '../../src/cli/scaffold.js';
import { createDefaultConfig, loadConfig, saveConfig } from '../../src/project/config.js';
import { openJobManifest } from '../../src/indexing/job-manifest.js';
import { acquireJob, finishJob } from '../../src/indexing/job-state.js';

vi.mock('../../src/project/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/project/config.js')>();
  return { ...actual, createDefaultConfig: vi.fn(actual.createDefaultConfig) };
});

let root: string;
let home: string;
let ignore: string;
beforeEach(async () => {
  root = fs.mkdtempSync(join(tmpdir(), 'pm-scaffold-'));
  home = fs.mkdtempSync(join(tmpdir(), 'pm-scaffold-home-'));
  vi.stubEnv('PROJECT_MEMORY_HOME', home);
  const config = await createDefaultConfig(root, { qdrant: 6333, typesense: 8108 });
  saveConfig(config);
  ignore = join(root, '.memory', '.gitignore');
  fs.writeFileSync(ignore, '# existing ignore rules\n');
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
describe('scaffold during indexing', () => {
  it('reloads config if another init creates it and starts a job while defaults are being prepared', async () => {
    const config = loadConfig(root);
    const configFile = join(root, '.memory', 'config.json');
    const beforeConfig = fs.readFileSync(configFile, 'utf8');
    const beforeIgnore = fs.readFileSync(ignore, 'utf8');
    fs.unlinkSync(configFile);
    vi.mocked(createDefaultConfig).mockImplementationOnce(async () => {
      saveConfig(config);
      const manifest = openJobManifest(root);
      try { acquireJob(manifest, root, 'init'); } finally { manifest.close(); }
      return { ...config, qdrantPort: 9999 };
    });
    expect(await scaffold(root)).toEqual(config);
    expect(fs.readFileSync(configFile, 'utf8')).toBe(beforeConfig);
    expect(fs.readFileSync(ignore, 'utf8')).toBe(beforeIgnore);
  });
  it.each(['init', 'sync'] as const)('preserves config files during an active %s job, then allows scaffold after completion', async (operation) => {
    const manifest = openJobManifest(root);
    try {
      const { job } = acquireJob(manifest, root, operation);
      const configPath = join(root, '.memory', 'config.json');
      const beforeConfig = fs.readFileSync(configPath, 'utf8');
      const beforeIgnore = fs.readFileSync(ignore, 'utf8');
      const beforeStat = fs.statSync(ignore);
      await scaffold(root);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(beforeConfig);
      expect(fs.readFileSync(ignore, 'utf8')).toBe(beforeIgnore);
      expect(fs.statSync(ignore).ino).toBe(beforeStat.ino);
      expect(fs.existsSync(join(root, '.memory', 'mcp.example.json'))).toBe(false);
      finishJob(manifest, job.id);
      await scaffold(root);
      expect(fs.readFileSync(ignore, 'utf8')).toContain('!annotations.json');
      expect(fs.existsSync(join(root, '.memory', 'mcp.example.json'))).toBe(true);
    } finally { manifest.close(); }
  });
});
