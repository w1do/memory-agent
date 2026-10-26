import { closeSync, constants, createReadStream, createWriteStream, fstatSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { DumpManifestBody } from './manifest.js';

export type Artifact = DumpManifestBody['artifacts'][number];

export async function writeArtifact(file: string, path: Artifact['path'], input: Readable, outputFd?: number): Promise<Artifact> {
  if (outputFd === undefined) await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const fd = outputFd ?? openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let uncompressedSize = 0;
  const hash = createHash('sha256');
  const count = new Transform({ transform(data: Buffer, _, cb) { uncompressedSize += data.length; cb(null, data); } });
  const digest = new Transform({ transform(data: Buffer, _, cb) { hash.update(data); cb(null, data); } });
  const streams = path.endsWith('.zst') ? [input, count, createZstdCompress(), digest] : [input, count, digest];
  try {
    await pipeline([...streams, createWriteStream(file, { fd, autoClose: false })]);
    return { path, sha256: hash.digest('hex'), compressedSize: fstatSync(fd).size, uncompressedSize };
  } finally { closeSync(fd); }
}

export async function unpackArtifact(file: string, target: string, artifact: Artifact): Promise<void> {
  const hash = createHash('sha256');
  let compressed = 0, unpacked = 0;
  const digest = new Transform({ transform(data: Buffer, _, cb) { compressed += data.length; hash.update(data); cb(null, data); } });
  const count = new Transform({ transform(data: Buffer, _, cb) {
    unpacked += data.length;
    cb(unpacked > artifact.uncompressedSize ? new Error(`${artifact.path}: uncompressed size exceeded`) : null, data);
  } });
  const streams = [createReadStream(file), digest, ...(file.endsWith('.zst') ? [createZstdDecompress()] : []), count];
  await pipeline([...streams, createWriteStream(target, { flags: 'wx', mode: 0o600 })]);
  if (compressed !== artifact.compressedSize || unpacked !== artifact.uncompressedSize || hash.digest('hex') !== artifact.sha256) {
    throw new Error(`${artifact.path}: SHA-256 or size mismatch`);
  }
}
