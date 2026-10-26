import { createReadStream, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';
import type { EnvMap, MemoryConfig } from '../project/config.js';
import { canonicalJson, fingerprintSchema, parseDumpManifest, type DumpManifest } from './manifest.js';
import { assertAllowedPath, assertNoSymlink, dumpPath } from './paths.js';
import { fingerprintSettings } from './provenance.js';
import type { Artifact } from './compression.js';

function checkVersions(input: unknown): void {
  if (!input || typeof input !== 'object') throw new Error('manifest.json: expected an object');
  const values = input as Record<string, unknown>;
  for (const field of ['formatVersion', 'sqliteSchemaVersion', 'idAlgorithmVersion']) {
    if (values[field] !== 1) {
      throw new Error(`manifest.json: unsupported ${field} ${JSON.stringify(values[field])}; supported: 1`);
    }
  }
}

function checkFingerprint(input: unknown, config: MemoryConfig, env: EnvMap): void {
  const dump = fingerprintSchema.safeParse(input);
  const settings = fingerprintSettings(config, env);
  const recipient = fingerprintSchema.safeParse(settings);
  const describe = (value: unknown) => {
    if (!value || typeof value !== 'object') return 'unknown';
    const record = value as Record<string, unknown>;
    return canonicalJson(Object.fromEntries(Object.keys(fingerprintSchema.shape).map((key) => {
      const value = record[key];
      return [key, value == null || (typeof value === 'number' && !Number.isFinite(value)) ? 'unknown' : value];
    })));
  };
  const configurations = `dump=${describe(input)}; recipient=${describe(settings)}`;
  if (!dump.success || !recipient.success) throw new Error(`Unknown or invalid embedding fingerprint: ${configurations}`);
  if (canonicalJson(dump.data) !== canonicalJson(recipient.data)) {
    throw new Error(`Embedding fingerprint mismatch: ${configurations}`);
  }
}

/** Stream to a sink: no extracted files, staging generations or active storage writes. */
async function checkArtifact(dir: string, artifact: Artifact): Promise<void> {
  try {
    assertNoSymlink(dir, artifact.path);
    const file = join(dir, artifact.path), stat = lstatSync(file);
    if (!stat.isFile()) throw new Error('Expected a regular file');
    if (stat.size !== artifact.compressedSize) throw new Error('compressed size mismatch');
    const hash = createHash('sha256');
    let compressed = 0, uncompressed = 0;
    const digest = new Transform({ transform(data: Buffer, _, cb) {
      compressed += data.length;
      hash.update(data);
      cb(compressed > artifact.compressedSize ? new Error('compressed size exceeded') : null, data);
    } });
    const sink = new Writable({ write(data: Buffer, _, cb) {
      uncompressed += data.length;
      cb(uncompressed > artifact.uncompressedSize ? new Error('uncompressed size exceeded') : null);
    } });
    await pipeline([createReadStream(file), digest, ...(artifact.path.endsWith('.zst') ? [createZstdDecompress()] : []), sink]);
    if (compressed !== artifact.compressedSize) throw new Error('compressed size mismatch');
    if (hash.digest('hex') !== artifact.sha256) throw new Error('SHA-256 mismatch');
    if (uncompressed !== artifact.uncompressedSize) throw new Error('uncompressed size mismatch');
  } catch (error) {
    throw new Error(`${artifact.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** M3 preflight only. Caller supplies configuration; no env files or embedding APIs are accessed. */
export async function checkMemoryImport(root: string, name: string, config: MemoryConfig, env: EnvMap = {}): Promise<DumpManifest> {
  const dir = dumpPath(root, name);
  assertNoSymlink(dir, 'manifest.json');
  if (!lstatSync(join(dir, 'manifest.json')).isFile()) throw new Error('manifest.json: expected a regular file');
  let input: unknown;
  try { input = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); }
  catch { throw new Error('manifest.json: invalid JSON or unreadable manifest'); }
  checkVersions(input);
  checkFingerprint((input as Record<string, unknown>).embedding, config, env);
  const manifest = parseDumpManifest(input);
  for (const file of manifest.files) assertAllowedPath(file.path);
  for (const artifact of manifest.artifacts) await checkArtifact(dir, artifact);
  return manifest;
}
