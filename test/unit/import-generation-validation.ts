import { expect, it } from 'vitest';
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { generationFixture } from './import-generation-fixture.js';
import { createDumpManifest } from '../../src/transfer/manifest.js';
import { sha256 } from '../../src/shared/hash.js';
import { activeGeneration } from '../../src/storage/generation.js';
import { Manifest } from '../../src/storage/manifest.js';

export function validationScenarios() {
  it.each(['payload', 'ordinals', 'counts'])('refuses inconsistent %s before publishing or creating a service collection', async (kind) => {
    const f = await generationFixture(); const before = readFileSync(f.legacyPath);
    const body = structuredClone(f.dump);
    if (kind === 'payload') {
      const path = join(f.root, 'memory/backup/qdrant/points.jsonl.zst');
      const rows = zstdDecompressSync(readFileSync(path)).toString().trim().split('\n').map((s) => JSON.parse(s));
      rows[0].payload.file_id = 'orphan';
      const bytes = Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'), compressed = zstdCompressSync(bytes);
      writeFileSync(path, compressed);
      Object.assign(body.artifacts.find((a) => a.path === 'qdrant/points.jsonl.zst')!, {
        sha256: sha256(compressed), compressedSize: compressed.length, uncompressedSize: bytes.length,
      });
    } else if (kind === 'ordinals') body.idParameters.ordinals[0].ordinal = 99;
    else body.counts.chunks++;
    const { dumpId: _, ...input } = body;
    writeFileSync(join(f.root, 'memory/backup/manifest.json'), JSON.stringify(createDumpManifest(input)));
    await expect(f.apply()).rejects.toThrow(); expect(f.events.filter((e) => e.startsWith('create-'))).toEqual([]);
    expect(activeGeneration(f.root)).toBeUndefined(); expect(readFileSync(f.legacyPath)).toEqual(before);
  });
  it('aborts staging if source files change during upload', async () => {
    const f = await generationFixture();
    f.onUpload(async () => { writeFileSync(join(f.root, 'src/a.ts'), 'changed during upload'); });
    await expect(f.apply()).rejects.toThrow('Local files changed'); expect(activeGeneration(f.root)).toBeUndefined();
    for (const remote of f.remotes.values()) expect(remote).toMatchObject({ qdrant: false, typesense: false });
  });
  it('treats a source symlink as stale without following it', async () => {
    const f = await generationFixture(); unlinkSync(join(f.root, 'src/a.ts'));
    symlinkSync(join(f.source.root, 'src/a.ts'), join(f.root, 'src/a.ts'));
    const { generation } = await f.apply(); expect(f.open(generation).getFile('src/a.ts')?.status).toBe('stale');
    expect(f.json(generation, 'file-state.json')[0]).toMatchObject({ sha256: null, status: 'stale' });
  });
  it('refuses to replace a generation while a background writer is queued', async () => {
    const f = await generationFixture(), old = new Manifest(f.legacyPath);
    old.setMeta('index_job:queued', JSON.stringify({ state: 'queued' })); old.close();
    await expect(f.apply()).rejects.toThrow('queued or running'); expect(activeGeneration(f.root)).toBeUndefined(); expect(f.events).toEqual([]);
  });
}
