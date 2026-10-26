import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import { dumpMemory } from '../../src/transfer/dump.js';
import { ARTIFACT_PATHS, parseDumpManifest } from '../../src/transfer/manifest.js';
import { acquireMemoryLock } from '../../src/storage/memory-lock.js';
import { sha256 } from '../../src/shared/hash.js';
import { scanProject } from '../../src/project/scan.js';
import { annotateFile } from '../../src/mcp/tools.js';
import { PROVENANCE_KEY, recordProvenance } from '../../src/transfer/provenance.js';
import { fixture, fingerprint, type Fixture } from './transfer-fixture.js';

const fixtures: Fixture[] = [];
const make = () => { const f = fixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

describe('memory dump', () => {
  it('exports all artifacts, fresh SQLite, full records, vectors, ordinals and newer-wins annotations', async () => {
    const f = make();
    const note = { relativePath: f.file.relativePath, summary: 'new', role: 'module', contentHash: f.file.sha256,
      author: 'agent', updatedAt: '2026-10-26T01:00:00.000Z' };
    f.manifest.upsertAnnotation({ ...note, summary: 'old', updatedAt: '2026-10-26T00:00:00.000Z' });
    writeFileSync(join(f.root, '.memory', 'annotations.json'), JSON.stringify([note]));
    // Secrets are deliberately never opened by the exporter.
    writeFileSync(join(f.root, '.env.private'), 'SECRET-MUST-NOT-TRANSFER');
    const m = await dumpMemory(f.ctx, 'backup');
    const dir = join(f.root, 'memory/backup');
    expect(readdirSync(dir).sort()).toEqual(['annotations.json.zst', 'index.db.zst', 'manifest.json', 'qdrant', 'typesense']);
    expect(parseDumpManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))).toEqual(m);
    expect(m.idParameters.ordinals.map((o) => o.ordinal).sort()).toEqual([0, 1]);
    for (const path of ARTIFACT_PATHS) {
      const bytes = readFileSync(join(dir, path)), a = m.artifacts.find((a) => a.path === path)!;
      expect(sha256(bytes)).toBe(a.sha256); expect(bytes.length).toBe(a.compressedSize);
      const raw = path.endsWith('.zst') ? zstdDecompressSync(bytes) : bytes;
      expect(raw.length).toBe(a.uncompressedSize);
      expect(raw.toString()).not.toContain('SECRET-MUST-NOT-TRANSFER');
      expect(raw.toString()).not.toContain('MUST-NOT-TRANSFER');
    }
    const dbPath = join(f.root, 'check.db');
    writeFileSync(dbPath, zstdDecompressSync(readFileSync(join(dir, 'index.db.zst'))));
    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    expect(db.prepare('SELECT summary FROM annotations').get()?.summary).toBe('new');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('index_errors','index_runs')").all()).toHaveLength(0);
    db.close(); expect(f.embeddingCalls).toBe(0);
    expect(scanProject(f.root, f.ctx.matcher, 524288).map((s) => s.relativePath)).toEqual(['src/a.ts']);
  });

  it('refuses pending embeddings and unfinished writes', async () => {
    const f = make(); f.manifest.replaceChunks(f.file.id, f.chunks, new Set());
    await expect(dumpMemory(f.ctx, 'pending')).rejects.toThrow('Pending embeddings');
    f.manifest.markEmbedded(f.chunks.map((c) => c.chunkId));
    f.manifest.setMeta('index_job:queued', JSON.stringify({ state: 'queued' }));
    await expect(dumpMemory(f.ctx, 'queued')).rejects.toThrow('Unfinished');
    expect(readdirSync(join(f.root, 'memory'))).toEqual([]);
  });

  it.each(['missing point', 'extra point', 'missing document', 'wrong chunkId', 'payload', 'nonfinite'])('refuses inconsistent source: %s', async (kind) => {
    const f = make();
    if (kind === 'missing point') f.vectors.points.pop();
    if (kind === 'extra point') f.vectors.points.push({ ...f.vectors.points[0], id: 'extra', payload: { ...f.vectors.points[0].payload, chunk_id: 'extra' } });
    if (kind === 'missing document') f.lexical.documents.pop();
    if (kind === 'wrong chunkId') f.vectors.points[0].payload.chunk_id = 'wrong';
    if (kind === 'payload') f.vectors.points[0].payload.content_hash = 'wrong';
    if (kind === 'nonfinite') f.vectors.points[0].vector[0] = Infinity;
    await expect(dumpMemory(f.ctx, 'bad')).rejects.toThrow();
    expect(existsSync(join(f.root, 'memory/bad'))).toBe(false);
    expect(readdirSync(join(f.root, 'memory'))).toEqual([]);
  });

  it('refuses forbidden data in SQLite, points, documents and annotations', async () => {
    for (const store of ['sqlite', 'points', 'documents', 'annotations']) {
      const f = make();
      if (store === 'sqlite') f.manifest.upsertFile({ ...f.file, relativePath: 'global.env' });
      if (store === 'points') f.vectors.points[0].payload.path = '.env.private';
      if (store === 'documents') f.lexical.documents[0].path = 'server.key';
      if (store === 'annotations') f.manifest.upsertAnnotation({ relativePath: '.env', summary: 'x', role: 'config', contentHash: 'x', author: 'agent', updatedAt: 'now' });
      await expect(dumpMemory(f.ctx, 'bad')).rejects.toThrow('Forbidden indexed path');
    }
  });

  it('refuses unknown or mixed stored provenance and records model changes as mixed', async () => {
    const f = make();
    recordProvenance(f.manifest, { ...fingerprint, model: 'another-model' });
    expect(f.manifest.getMeta(PROVENANCE_KEY)).toBe('mixed');
    await expect(dumpMemory(f.ctx, 'mixed')).rejects.toThrow('provenance');
    f.manifest.deleteMeta(PROVENANCE_KEY);
    await expect(dumpMemory(f.ctx, 'unknown')).rejects.toThrow('provenance');
  });

  it('refuses existing names and unsafe paths including symlinks', async () => {
    const f = make(); await dumpMemory(f.ctx, 'saved');
    const before = readFileSync(join(f.root, 'memory/saved/manifest.json'));
    await expect(dumpMemory(f.ctx, 'saved')).rejects.toThrow('already exists');
    expect(readFileSync(join(f.root, 'memory/saved/manifest.json'))).toEqual(before);
    for (const name of ['../x', '/tmp/x', 'a/b', '..', 'a..b', 'a\\b', '']) await expect(dumpMemory(f.ctx, name)).rejects.toThrow();
    symlinkSync(join(f.root, 'src'), join(f.root, 'memory/link'));
    await expect(dumpMemory(f.ctx, 'link')).rejects.toThrow('Symlink');
    const g = make(); symlinkSync(join(g.root, 'src'), join(g.root, 'memory'));
    await expect(dumpMemory(g.ctx, 'outside')).rejects.toThrow('Symlink');
  });

  it('removes staging after a failure before publication', async () => {
    const f = make(); f.ctx.typesense.exportSnapshot = async () => { throw Error('network failure'); };
    await expect(dumpMemory(f.ctx, 'failed')).rejects.toThrow('network failure');
    expect(readdirSync(join(f.root, 'memory'))).toEqual([]);
  });

  it('uses an OS lock across processes and blocks annotations during a snapshot', async () => {
    const f = make(), release = acquireMemoryLock(f.root);
    const script = "const {DatabaseSync}=require('node:sqlite');try{const d=new DatabaseSync(process.argv[1]);d.exec('BEGIN IMMEDIATE');process.exit(9)}catch{process.exit(0)}";
    try {
      expect(spawnSync(process.execPath, ['-e', script, join(f.root, '.memory/mutation-lock.db')]).status).toBe(0);
      await expect(dumpMemory(f.ctx, 'locked')).rejects.toThrow('busy');
      expect(() => annotateFile(f.ctx, { path: f.file.relativePath, summary: 'x', role: 'module', content_hash: f.file.sha256 })).toThrow('busy');
    } finally { release(); }
    await expect(dumpMemory(f.ctx, 'released')).resolves.toHaveProperty('dumpId');
  });
});
