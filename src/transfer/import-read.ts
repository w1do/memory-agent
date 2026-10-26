import { createReadStream, createWriteStream, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, type DumpManifest } from './manifest.js';
import { readIndex } from './sqlite.js';
import { annotationsOf } from './annotations.js';
import { idParameters, logicalSummary, validateSnapshot } from './consistency.js';
import { assertNoSymlink, dumpPath } from './paths.js';
import type { Snapshot } from './types.js';
import { PROVENANCE_KEY, storedFingerprint } from './provenance.js';

/** Recheck bytes during extraction as well: the dump may change after preflight. */
export async function readImportSnapshot(root: string, name: string, manifest: DumpManifest, staging: string): Promise<Snapshot> {
  const source = dumpPath(root, name), dir = join(staging, 'source');
  mkdirSync(dir);
  try {
    for (const artifact of manifest.artifacts) {
      assertNoSymlink(source, artifact.path);
      const target = join(dir, artifact.path.replace(/\.zst$/, ''));
      mkdirSync(dirname(target), { recursive: true });
      let bytes = 0, compressed = 0;
      const hash = createHash('sha256');
      const digest = new Transform({ transform(data: Buffer, _, cb) {
        hash.update(data); compressed += data.length;
        cb(compressed > artifact.compressedSize ? new Error(`${artifact.path}: compressed size exceeded`) : null, data);
      } });
      const limit = new Transform({ transform(data: Buffer, _, cb) {
        bytes += data.length;
        cb(bytes > artifact.uncompressedSize ? new Error(`${artifact.path}: uncompressed size exceeded`) : null, data);
      } });
      await pipeline([createReadStream(join(source, artifact.path)), digest,
        ...(artifact.path.endsWith('.zst') ? [createZstdDecompress()] : []), limit, createWriteStream(target, { flags: 'wx', mode: 0o600 })]);
      if (hash.digest('hex') !== artifact.sha256 || compressed !== artifact.compressedSize || bytes !== artifact.uncompressedSize) {
        throw new Error(`${artifact.path}: checksum or size changed during import`);
      }
    }
    const db = new DatabaseSync(join(dir, 'index.db'), { readOnly: true });
    let index;
    try { index = readIndex(db); } finally { db.close(); }
    const json = (path: string) => JSON.parse(readFileSync(join(dir, path), 'utf8'));
    const jsonl = (path: string) => readFileSync(join(dir, path), 'utf8').split('\n').filter((s) => s.trim()).map((s) => JSON.parse(s));
    const bytes = readFileSync(join(dir, 'qdrant/vectors.f32le'));
    const dimensions = manifest.embedding.dimensions;
    const points = jsonl('qdrant/points.jsonl');
    if (bytes.length !== points.length * dimensions * 4) throw new Error('Vector byte count mismatch');
    const snapshot: Snapshot = { index,
      vectors: { version: manifest.services.qdrant, parameters: manifest.collections.qdrant,
        points: points.map((p, ordinal) => {
          if (p.ordinal !== ordinal) throw new Error('Point ordinal mismatch');
          return { id: p.id, payload: p.payload, vector: Array.from({ length: dimensions }, (_, i) => bytes.readFloatLE((ordinal * dimensions + i) * 4)) };
        }) },
      lexical: { version: manifest.services.typesense, schema: json('typesense/schema.json'), documents: jsonl('typesense/documents.jsonl') },
    };
    validateSnapshot(snapshot, manifest.sourceProjectId, dimensions);
    const provenance = storedFingerprint(index.meta.find((r) => r.key === PROVENANCE_KEY)?.value as string | undefined);
    if (canonicalJson(provenance) !== canonicalJson(manifest.embedding)) throw new Error('Stored vector provenance differs from manifest');
    const files = index.files.map((f) => ({ path: f.relative_path, sha256: f.sha256, size: f.size }));
    const sortFiles = (items: typeof files) => [...items].sort((a, b) => String(a.path).localeCompare(String(b.path), 'en'));
    if (canonicalJson(sortFiles(files)) !== canonicalJson(sortFiles(manifest.files))) throw new Error('Indexed file manifest mismatch');
    if (canonicalJson(idParameters(index)) !== canonicalJson(manifest.idParameters)) throw new Error('ID parameters mismatch');
    if (canonicalJson(logicalSummary(snapshot)) !== canonicalJson({ counts: manifest.counts, logicalHashes: manifest.logicalHashes })) {
      throw new Error('Logical snapshot mismatch');
    }
    if (canonicalJson(json('annotations.json')) !== canonicalJson(annotationsOf(index))) throw new Error('Annotations snapshot mismatch');
    if (canonicalJson(snapshot.lexical.schema) !== canonicalJson(manifest.collections.typesense)) throw new Error('Typesense schema mismatch');
    if ((snapshot.vectors.parameters.vectors as { distance?: string }).distance !== manifest.embedding.distance) throw new Error('Vector distance mismatch');
    return snapshot;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
