import { closeSync, createReadStream, unlinkSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { MemoryContext } from '../shared/context.js';
import { withMemoryLock } from '../storage/memory-lock.js';
import { ARTIFACT_PATHS, canonicalJson, createDumpManifest, type DumpManifest } from './manifest.js';
import { dumpPath } from './paths.js';
import { createDumpDirectory } from './dump-directory.js';
import { writeIndex } from './sqlite.js';
import { storedFingerprint, PROVENANCE_KEY } from './provenance.js';
import { validateSnapshot, logicalSummary, idParameters } from './consistency.js';
import { annotationsOf, mergeAnnotations } from './annotations.js';
import { writeArtifact } from './compression.js';
import type { Snapshot } from './types.js';
import { annotationsPath } from '../global/annotations-file.js';

export async function dumpMemory(ctx: MemoryContext, name: string): Promise<DumpManifest> {
  dumpPath(ctx.root, name);
  return withMemoryLock(ctx.root, async () => {
    const directory = createDumpDirectory(ctx.root, name);
    try {
      const index = ctx.manifest.transferSnapshot();
      const embedding = storedFingerprint(index.meta.find((r) => r.key === PROVENANCE_KEY)?.value as string | undefined);
      if (index.chunks.some((c) => c.embedded !== 1)) throw new Error('Pending embeddings; snapshot refused');
      mergeAnnotations(ctx.root, index, annotationsPath(ctx.root, ctx.manifest));
      const vectors = await ctx.qdrant.exportSnapshot();
      directory.assertAttached();
      const lexical = await ctx.typesense.exportSnapshot();
      directory.assertAttached();
      const snapshot: Snapshot = { index, vectors, lexical };
      validateSnapshot(snapshot, ctx.config.projectId, embedding.dimensions);
      if ((vectors.parameters.vectors as { distance?: string }).distance !== embedding.distance) throw new Error('Collection distance differs from provenance');
      const db = directory.file('index.db');
      closeSync(directory.createFile('index.db'));
      writeIndex(db, index);
      const jsonl = (items: unknown[]) => Readable.from(items.map((i) => canonicalJson(i) + '\n'));
      const vectorBytes = function* () {
        for (const point of vectors.points) {
          const buffer = Buffer.alloc(point.vector.length * 4);
          point.vector.forEach((v, i) => buffer.writeFloatLE(v, i * 4));
          yield buffer;
        }
      };
      const inputs = [createReadStream(db), Readable.from([canonicalJson(annotationsOf(index))]),
        jsonl(vectors.points.map((p, ordinal) => ({ id: p.id, payload: p.payload, ordinal }))),
        Readable.from(vectorBytes()), jsonl(lexical.documents), Readable.from([canonicalJson(lexical.schema)])];
      const artifacts = [];
      for (let i = 0; i < ARTIFACT_PATHS.length; i++) {
        const path = ARTIFACT_PATHS[i];
        artifacts.push(await writeArtifact(directory.file(path), path, inputs[i], directory.createFile(path)));
        directory.assertAttached();
      }
      unlinkSync(db);
      const manifest = createDumpManifest({ formatVersion: 1, appVersion: '0.1.0', sqliteSchemaVersion: 1,
        idAlgorithmVersion: 1, sourceProjectId: ctx.config.projectId, createdAt: new Date().toISOString(),
        services: { qdrant: vectors.version, typesense: lexical.version },
        collections: { qdrant: vectors.parameters, typesense: lexical.schema }, embedding, artifacts,
        files: index.files.map((f) => ({ path: String(f.relative_path), sha256: String(f.sha256), size: Number(f.size) })),
        ...logicalSummary(snapshot), idParameters: idParameters(index) });
      const fd = directory.createFile('manifest.json');
      try { writeFileSync(fd, canonicalJson(manifest) + '\n'); } finally { closeSync(fd); }
      directory.publish();
      return manifest;
    } finally { directory.close(); }
  });
}
