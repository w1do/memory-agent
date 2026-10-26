import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, type Fixture } from './transfer-fixture.js';
import { dumpMemory } from '../../src/transfer/dump.js';
import { dumpCommand } from '../../src/cli/commands/transfer.js';
import { saveConfig } from '../../src/project/config.js';
import { indexDbPath } from '../../src/global/paths.js';

const fixtures: Fixture[] = [];
const make = () => { const f = fixture(); fixtures.push(f); return f; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const f of fixtures.splice(0)) f.cleanup(); });

describe('dump security boundaries', () => {
  it.each(['entities', 'relations', 'constraints', 'role', 'author', 'contentHash', 'relativePath', 'updatedAt'])(
    'refuses secrets in annotation field %s without including the value', async (field) => {
      const f = make(), secret = 'sk-' + 'FAKE'.repeat(8);
      const note = { relativePath: f.file.relativePath, summary: 'safe', role: 'module', contentHash: f.file.sha256,
        author: 'agent', updatedAt: '2026-10-26T01:00:00.000Z', [field]: ['entities', 'relations', 'constraints'].includes(field)
          ? [{ description: `Uses ${secret}` }] : `Uses ${secret}` };
      writeFileSync(join(f.root, '.memory/annotations.json'), JSON.stringify([note]));
      const error = await dumpMemory(f.ctx, 'bad').catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`Secret detected in ${field}`);
      expect((error as Error).message).not.toContain(secret);
      expect(readdirSync(join(f.root, 'memory'))).toEqual([]);
    });

  it('does not write annotations through a symlink when a rejected CLI dump closes its context', async () => {
    const f = make();
    vi.stubEnv('PROJECT_MEMORY_HOME', join(f.root, '.global'));
    saveConfig(f.ctx.config);
    // Resolve the real context to this fixture's SQLite without mocking internal code.
    const index = indexDbPath(f.ctx.config.projectId);
    mkdirSync(join(index, '..'), { recursive: true });
    symlinkSync(f.manifest.filePath, index);
    const outside = join(f.root, 'outside.json');
    const text = JSON.stringify([{ relativePath: f.file.relativePath, summary: 'safe', role: 'module',
      contentHash: f.file.sha256, author: 'agent', updatedAt: '2026-10-26T01:00:00.000Z' }]);
    writeFileSync(outside, text);
    symlinkSync(outside, join(f.root, '.memory/annotations.json'));
    await expect(dumpCommand('bad', { path: f.root })).rejects.toThrow('Symlink');
    expect(readFileSync(outside, 'utf8')).toBe(text);
    expect(existsSync(join(f.root, 'memory/bad'))).toBe(false);
  });

  it.each(['staging', 'memory', 'qdrant', 'typesense'])('refuses %s replacement during network export without writing outside', async (part) => {
    const f = make(), outside = join(f.root, 'outside');
    mkdirSync(outside);
    const exportSnapshot = f.ctx.qdrant.exportSnapshot.bind(f.ctx.qdrant);
    f.ctx.qdrant.exportSnapshot = async () => {
      const memory = join(f.root, 'memory'), staging = join(memory, readdirSync(memory)[0]);
      const target = part === 'memory' ? memory : part === 'staging' ? staging : join(staging, part);
      renameSync(target, join(f.root, 'moved'));
      symlinkSync(outside, target);
      return exportSnapshot();
    };
    await expect(dumpMemory(f.ctx, 'bad')).rejects.toThrow('Dump directory changed');
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(f.root, 'memory/bad'))).toBe(false);
  });
});
