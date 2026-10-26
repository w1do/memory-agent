import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stableId, sha256, toUuid } from '../shared/hash.js';
import { loadMatcher, scanProject } from '../project/scan.js';
import type { MemoryConfig } from '../project/config.js';
import { canonicalJson, type DumpManifest } from './manifest.js';
import { assertAllowedPath, assertNoSymlink } from './paths.js';
import type { Snapshot } from './types.js';

export interface IdMap {
  version: 1; projects: Record<string, string>; files: Record<string, string>;
  chunks: Record<string, string>; points: Record<string, string>;
}
export interface FileState { path: string; status: 'indexed' | 'stale' | 'unindexed'; sha256: string | null; mtimeMs: number | null }

export function localFiles(root: string, manifest: DumpManifest, config: MemoryConfig): FileState[] {
  const indexed = new Map(manifest.files.map((f) => [f.path, f]));
  const paths = new Set([...indexed.keys(), ...scanProject(root, loadMatcher(root), config.maxFileSize).map((f) => f.relativePath)]);
  return [...paths].sort().flatMap((path): FileState[] => {
    // Never open forbidden files, including extra local files skipped by transfer policy.
    try { assertAllowedPath(path); } catch (e) { if (indexed.has(path)) throw e; else return []; }
    let hash: string | null = null, mtimeMs: number | null = null;
    try {
      assertNoSymlink(root, path);
      const stat = lstatSync(join(root, path));
      if (stat.isFile()) { hash = sha256(readFileSync(join(root, path))); mtimeMs = Math.floor(stat.mtimeMs); }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && !String(e).includes('Symlink is forbidden')) throw e;
    }
    return [{ path, sha256: hash, mtimeMs, status: indexed.has(path) ? hash === indexed.get(path)!.sha256 ? 'indexed' : 'stale' : 'unindexed' }];
  });
}

export const localFilesHash = (files: FileState[]): string => sha256(canonicalJson(files));

/** Algorithm v1 is exactly the indexing algorithm, including duplicate chunk ordinals. */
export function rebindSnapshot(snapshot: Snapshot, manifest: DumpManifest, config: MemoryConfig, files: FileState[]): IdMap {
  const { index, vectors, lexical } = snapshot;
  const map: IdMap = { version: 1, projects: { [manifest.sourceProjectId]: config.projectId }, files: {}, chunks: {}, points: {} };
  const local = new Map(files.map((f) => [f.path, f]));
  for (const file of index.files) {
    const id = String(file.id), path = String(file.relative_path), state = local.get(path)!;
    map.files[id] = stableId(config.projectId, path);
    file.id = map.files[id]; file.path = join(config.root, path); file.status = state.status;
    file.mtime_ms = state.status === 'indexed' ? state.mtimeMs : -1;
  }
  for (const project of index.projects) { project.id = config.projectId; project.name = config.projectName; project.root = config.root; }
  const ordinals = new Map(manifest.idParameters.ordinals.map((c) => [c.chunkId, c]));
  for (const chunk of index.chunks) {
    const id = String(chunk.chunk_id), params = ordinals.get(id)!;
    chunk.file_id = map.files[String(chunk.file_id)];
    map.chunks[id] = stableId(String(chunk.file_id), params.key, String(params.ordinal));
    map.points[toUuid(id)] = toUuid(map.chunks[id]);
    chunk.chunk_id = map.chunks[id];
  }
  for (const table of ['symbols', 'imports', 'exports'] as const) {
    for (const row of index[table]) row.file_id = map.files[String(row.file_id)];
  }
  for (const point of vectors.points) {
    point.id = map.points[point.id];
    point.payload = { ...point.payload, project_id: config.projectId, file_id: map.files[point.payload.file_id], chunk_id: map.chunks[point.payload.chunk_id] };
  }
  for (const doc of lexical.documents) {
    doc.id = map.chunks[doc.id]; doc.chunk_id = map.chunks[doc.chunk_id]; doc.file_id = map.files[doc.file_id]; doc.project_id = config.projectId;
  }
  index.meta.push({ key: 'import_source_project_id', value: manifest.sourceProjectId },
    { key: 'import_dump_id', value: manifest.dumpId }, { key: 'import_dirty', value: '0' },
    { key: 'import_unindexed', value: canonicalJson(files.filter((f) => f.status === 'unindexed').map((f) => f.path)) });
  return map;
}
