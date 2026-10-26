import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ARTIFACT_PATHS, canonicalJson, createDumpManifest, parseDumpManifest,
  type DumpManifestBody,
} from '../../src/transfer/manifest.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const body = (): DumpManifestBody => ({
  formatVersion: 1, appVersion: '0.1.0', sqliteSchemaVersion: 1, idAlgorithmVersion: 1,
  sourceProjectId: 'source', createdAt: '2026-10-26T00:00:00.000Z',
  services: { qdrant: '1.19.0', typesense: '30.0' },
  collections: { qdrant: { size: 2, distance: 'Cosine' }, typesense: { fields: [] } },
  embedding: { model: 'test', revision: 'weights-sha256', dimensions: 2, inputProcessing: 'raw',
    truncation: 'none', normalization: 'l2', distance: 'Cosine' },
  artifacts: ARTIFACT_PATHS.map((path) => ({ path, sha256: hash(path), compressedSize: 10, uncompressedSize: 20 })),
  files: [{ path: 'src/a.ts', sha256: hash('indexed bytes'), size: 13 }],
  counts: { files: 1, chunks: 2, points: 2, documents: 2 }, logicalHashes: { sqlite: hash('rows') },
  idParameters: { hash: 'sha256-nul-32', file: 'projectId,relativePath', chunk: 'fileId,key,ordinal',
    point: 'toUuid-v1', ordinals: [{ chunkId: 'first', key: 'x|hash', ordinal: 0 },
      { chunkId: 'second', key: 'x|hash', ordinal: 1 }] },
});

describe('dump manifest v1', () => {
  it('records versions, collections, provenance, checksums, sizes, counts and duplicate chunk ordinals', () => {
    const manifest = createDumpManifest(body());
    expect(parseDumpManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(manifest.artifacts.map((a) => a.path)).toEqual(ARTIFACT_PATHS);
    expect(manifest.files[0]).toEqual({ path: 'src/a.ts', sha256: hash('indexed bytes'), size: 13 });
    expect(manifest.idParameters.ordinals.map((x) => x.ordinal)).toEqual([0, 1]);
  });

  it('hashes the canonical body without dumpId, independently of object insertion order', () => {
    const input = body();
    const reversed = Object.fromEntries(Object.entries(input).reverse()) as DumpManifestBody;
    expect(createDumpManifest(reversed).dumpId).toBe(createDumpManifest(input).dumpId);
    expect(createDumpManifest(input).dumpId).toBe(hash(canonicalJson(input)));
    expect(canonicalJson({ z: { b: 2, a: 1 }, a: ['x', 'y'] })).toBe('{"a":["x","y"],"z":{"a":1,"b":2}}');
  });

  it('binds artifact hashes, file hashes and ordinal mappings into dumpId', () => {
    const original = createDumpManifest(body());
    for (const mutate of [
      (b: DumpManifestBody) => { b.artifacts[0].sha256 = hash('changed'); },
      (b: DumpManifestBody) => { b.files[0].sha256 = hash('changed'); },
      (b: DumpManifestBody) => { b.idParameters.ordinals[1].ordinal = 2; },
    ]) {
      const changed = body(); mutate(changed);
      expect(createDumpManifest(changed).dumpId).not.toBe(original.dumpId);
      expect(() => parseDumpManifest({ ...changed, dumpId: original.dumpId })).toThrow('dumpId mismatch');
    }
  });

  it('rejects missing or duplicated artifacts, invalid hashes, sizes and nonportable paths', () => {
    const mutations = [
      (b: DumpManifestBody) => { b.artifacts.pop(); },
      (b: DumpManifestBody) => { b.artifacts[1] = b.artifacts[0]; },
      (b: DumpManifestBody) => { b.files[0].sha256 = 'bad'; },
      (b: DumpManifestBody) => { b.artifacts[0].compressedSize = -1; },
      (b: DumpManifestBody) => { b.files.push(b.files[0]); },
    ];
    for (const path of ['/tmp/a', '../a', 'a/../b', 'C:/a', 'a\\b', 'a//b', './a', 'a\0b']) {
      mutations.push((b) => { b.files[0].path = path; });
    }
    for (const mutate of mutations) { const b = body(); mutate(b); expect(() => createDumpManifest(b)).toThrow(); }
  });

  it('rejects incomplete or unknown embedding provenance and unsupported versions', () => {
    for (const key of Object.keys(body().embedding)) {
      const b = body(); delete (b.embedding as Record<string, unknown>)[key];
      expect(() => createDumpManifest(b)).toThrow();
    }
    for (const revision of ['', 'unknown', 'mixed']) {
      const b = body(); b.embedding.revision = revision; expect(() => createDumpManifest(b)).toThrow();
    }
    for (const key of ['formatVersion', 'sqliteSchemaVersion', 'idAlgorithmVersion']) {
      expect(() => createDumpManifest({ ...body(), [key]: 2 })).toThrow();
    }
  });

  it('rejects JSON values that would be silently lost or changed', () => {
    for (const value of [undefined, NaN, Infinity, { a: undefined }, new Date(), [, 1]]) {
      expect(() => canonicalJson(value)).toThrow();
    }
  });
});
