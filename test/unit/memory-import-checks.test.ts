import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { checkMemoryImport } from '../../src/transfer/import-checks.js';
import { dumpMemory } from '../../src/transfer/dump.js';
import { ARTIFACT_PATHS, canonicalJson, type DumpManifest } from '../../src/transfer/manifest.js';
import { sha256 } from '../../src/shared/hash.js';
import { fixture, fingerprint, type Fixture } from './transfer-fixture.js';

vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>() }));
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>() }));

const fixtures: Fixture[] = [];
beforeEach(() => {
  for (const key of ['MODEL', 'REVISION', 'DIMENSIONS']) vi.stubEnv(`EMBEDDING_${key}`, '');
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const f of fixtures.splice(0)) f.cleanup();
});
async function make() {
  const f = fixture(); fixtures.push(f);
  const manifest = await dumpMemory(f.ctx, 'backup');
  return { f, manifest, dir: join(f.root, 'memory/backup') };
}
function save(dir: string, manifest: DumpManifest) {
  const { dumpId: _, ...body } = manifest;
  fs.writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...body, dumpId: sha256(canonicalJson(body)) }));
}
async function check(f: Fixture, env: Record<string, string> = {}) {
  const before = f.manifest.transferSnapshot(), vectors = structuredClone(f.vectors), lexical = structuredClone(f.lexical);
  const bytes = fs.readFileSync(join(f.root, '.memory/index.db'));
  // No filesystem mutations at all: includes global.env, SQLite, annotations and generation pointers.
  const writes = [vi.spyOn(fs, 'writeFileSync'), vi.spyOn(fs, 'appendFileSync'), vi.spyOn(fs, 'renameSync'),
    vi.spyOn(fs, 'mkdirSync'), vi.spyOn(fs, 'rmSync'), vi.spyOn(fs, 'unlinkSync'), vi.spyOn(fs, 'createWriteStream'),
    vi.spyOn(fsp, 'writeFile'), vi.spyOn(fsp, 'appendFile'), vi.spyOn(fsp, 'rename'), vi.spyOn(fsp, 'mkdir'), vi.spyOn(fsp, 'rm')];
  try { return await checkMemoryImport(f.root, 'backup', f.ctx.config, env); }
  finally {
    for (const spy of writes) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
    expect(f.manifest.transferSnapshot()).toEqual(before);
    expect(fs.readFileSync(join(f.root, '.memory/index.db'))).toEqual(bytes);
    expect(f.vectors).toEqual(vectors); expect(f.lexical).toEqual(lexical);
    expect(f.embeddingCalls).toBe(0);
  }
}

describe('memory import preflight (M3)', () => {
  it('accepts a matching dump without writes, embeddings or extraction', async () => {
    const { f, manifest } = await make();
    await expect(check(f)).resolves.toEqual(manifest);
    expect(fs.readdirSync(join(f.root, 'memory'))).toEqual(['backup']);
  });
  it.each(ARTIFACT_PATHS.flatMap((path) => ['sha256', 'compressedSize', 'uncompressedSize'].map((field) => ({ path, field }))))(
    'rejects $path with mismatched $field before any mutation', async ({ path, field }) => {
      const { f, manifest, dir } = await make();
      const artifact = manifest.artifacts.find((a) => a.path === path)!;
      if (field === 'sha256') artifact.sha256 = '0'.repeat(64);
      else if (field === 'compressedSize') artifact.compressedSize++;
      else artifact.uncompressedSize++;
      save(dir, manifest);
      await expect(check(f)).rejects.toThrow(path);
    });
  it('rejects corrupt compressed bytes and names the artifact', async () => {
    const { f, dir } = await make();
    const path = 'index.db.zst', bytes = fs.readFileSync(join(dir, path));
    bytes[0] ^= 255; fs.writeFileSync(join(dir, path), bytes);
    await expect(check(f)).rejects.toThrow(path);
  });
  it.each(['formatVersion', 'sqliteSchemaVersion', 'idAlgorithmVersion'] as const)('explains unsupported %s', async (field) => {
    const { f, manifest, dir } = await make();
    fs.writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, [field]: 99 }));
    await expect(check(f)).rejects.toThrow(`unsupported ${field} 99; supported: 1`);
  });
  it.each(['model', 'revision', 'inputProcessing', 'dimensions', 'truncation', 'normalization', 'distance'] as const)(
    'refuses differing %s and reports both full configurations', async (field) => {
      const { f, manifest, dir } = await make();
      Object.assign(manifest.embedding, { [field]: field === 'dimensions' ? 3 : field === 'distance' ? 'Dot' : 'different' });
      save(dir, manifest);
      const message = await check(f).catch((error: Error) => error.message);
      expect(message).toContain('Embedding fingerprint mismatch');
      expect(message).toContain(`dump=${canonicalJson(manifest.embedding)}`);
      expect(message).toContain(`recipient=${canonicalJson(fingerprint)}`);
    });
  it.each(['model', 'revision', 'inputProcessing', 'dimensions', 'truncation', 'normalization', 'distance'] as const)(
    'rejects unknown dump fingerprint %s', async (field) => {
      const { f, manifest, dir } = await make();
      Object.assign(manifest.embedding, { [field]: 'unknown' }); save(dir, manifest);
      await expect(check(f)).rejects.toThrow('Unknown or invalid embedding fingerprint');
    });
  it.each(['MODEL', 'REVISION', 'DIMENSIONS'])('honors effective process override EMBEDDING_%s', async (key) => {
    const { f } = await make(); vi.stubEnv(`EMBEDDING_${key}`, key === 'DIMENSIONS' ? '3' : 'override');
    await expect(check(f)).rejects.toThrow('Embedding fingerprint mismatch');
  });
  it('honors supplied environment and process precedence without reading env files', async () => {
    const { f } = await make();
    await expect(check(f, { EMBEDDING_MODEL: 'env-model' })).rejects.toThrow('env-model');
    vi.stubEnv('EMBEDDING_MODEL', fingerprint.model);
    await expect(check(f, { EMBEDDING_MODEL: 'env-model' })).resolves.toHaveProperty('dumpId');
    vi.stubEnv('EMBEDDING_REVISION', 'unknown');
    await expect(check(f)).rejects.toThrow('Unknown or invalid embedding fingerprint');
  });
  it('rejects tampered manifest identity, missing artifacts and symlinks', async () => {
    const { f, manifest, dir } = await make();
    fs.writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, dumpId: '0'.repeat(64) }));
    await expect(check(f)).rejects.toThrow('dumpId mismatch'); save(dir, manifest);
    fs.unlinkSync(join(dir, 'typesense/schema.json'));
    await expect(check(f)).rejects.toThrow('typesense/schema.json');
    fs.symlinkSync(join(f.root, 'src/a.ts'), join(dir, 'typesense/schema.json'));
    await expect(check(f)).rejects.toThrow('Symlink');
  });
  it('rejects unsafe dump names and forbidden manifest paths', async () => {
    const { f, manifest, dir } = await make();
    for (const name of ['../x', '/tmp/x', 'a/b', 'a..b', '']) {
      await expect(checkMemoryImport(f.root, name, f.ctx.config)).rejects.toThrow('safe path component');
    }
    manifest.files[0].path = 'global.env'; save(dir, manifest);
    await expect(check(f)).rejects.toThrow('Forbidden indexed path');
    manifest.files[0].path = '../escape'; save(dir, manifest);
    await expect(check(f)).rejects.toThrow('portable relative path');
  });
});
