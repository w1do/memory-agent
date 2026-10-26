import { expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generationFixture } from './import-generation-fixture.js';
import { saveConfig } from '../../src/project/config.js';
import { openContext } from '../../src/shared/context.js';
import { createResolver } from '../../src/mcp/projects.js';
import { withWriter } from '../../src/indexing/writer.js';
import { annotateFile } from '../../src/mcp/tools.js';
import { activeGeneration } from '../../src/storage/generation.js';

export function readerScenarios() {
  it('keeps readers on the old generation until all four new stores are ready', async () => {
    const f = await generationFixture(); saveConfig(f.config);
    const old = openContext(f.root, { quiet: true });
    try {
      f.onUpload(async () => {
        expect(activeGeneration(f.root)).toBeUndefined(); expect(old.manifest.counts().chunks).toBe(0);
        expect(old.config.collection).toBe('recipient-local');
        await expect(withWriter(old, 'sync', async () => 1, () => '')).rejects.toThrow('locked');
      });
      const { generation } = await f.apply();
      const current = openContext(f.root, { quiet: true });
      try {
        expect(old.manifest.counts().chunks).toBe(0); expect(old.config.collection).toBe('recipient-local');
        expect(current.manifest.filePath).toBe(generation.indexPath); expect(current.manifest.annotationsFile).toBe(generation.annotationsPath);
        expect(current.config.collection).toBe(generation.collection); expect(current.manifest.counts().chunks).toBe(2);
        const work = vi.fn(async () => 1);
        await expect(withWriter(old, 'sync', work, () => '')).rejects.toThrow('generation changed'); expect(work).not.toHaveBeenCalled();
      } finally { current.close(); }
    } finally { old.close(); }
  });
  it('refreshes a cached MCP context on the next request after publication', async () => {
    const f = await generationFixture(); saveConfig(f.config);
    const resolver = createResolver(f.root);
    try {
      const old = resolver.resolve(); await f.apply(); const current = resolver.resolve();
      expect(current).not.toBe(old); expect(current.manifest.counts().chunks).toBe(2);
      expect(old.manifest.counts().chunks).toBe(0);
      expect(resolver.resolve()).toBe(current);
    } finally { resolver.closeAll(); }
  });
  it('refuses annotations for stale files even when the old indexed hash matches', async () => {
    const f = await generationFixture(); writeFileSync(join(f.root, 'src/a.ts'), 'local change');
    await f.apply(); const current = openContext(f.root, { quiet: true });
    try {
      expect(() => annotateFile(current, { path: 'src/a.ts', summary: 'stale', role: 'module', content_hash: f.source.file.sha256 })).toThrow('memory_update');
      expect(current.manifest.getAnnotation('src/a.ts')).toBeUndefined();
    } finally { current.close(); }
  });
}
