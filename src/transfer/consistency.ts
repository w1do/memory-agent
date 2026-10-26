import { stableId, sha256, toUuid } from '../shared/hash.js';
import { canonicalJson, type DumpManifestBody } from './manifest.js';
import { assertAllowedPath, assertPortablePath } from './paths.js';
import type { LogicalIndex, Row, Table } from './sqlite.js';
import type { Snapshot } from './types.js';

export function idParameters(index: LogicalIndex): DumpManifestBody['idParameters'] {
  const groups = new Map<string, Row[]>();
  for (const c of index.chunks) {
    const key = `${c.file_id}\0${c.symbol}|${c.content_hash}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const ordinals: DumpManifestBody['idParameters']['ordinals'] = [];
  for (const group of groups.values()) {
    const first = group[0], key = `${first.symbol}|${first.content_hash}`;
    for (let ordinal = 0; ordinal < group.length; ordinal++) {
      const chunkId = stableId(String(first.file_id), key, String(ordinal));
      if (!group.some((c) => c.chunk_id === chunkId)) throw new Error('Unsupported chunk ID algorithm or missing duplicate ordinal');
      ordinals.push({ chunkId, key, ordinal });
    }
  }
  ordinals.sort((a, b) => a.chunkId.localeCompare(b.chunkId, 'en'));
  return { hash: 'sha256-nul-32', file: 'projectId,relativePath', chunk: 'fileId,key,ordinal', point: 'toUuid-v1', ordinals };
}

function unique<T>(items: T[], id: (item: T) => string, label: string): Map<string, T> {
  const map = new Map(items.map((item) => [id(item), item]));
  if (map.size !== items.length) throw new Error(`Duplicate ${label}`);
  return map;
}

export function validateSnapshot(snapshot: Snapshot, projectId: string, dimensions: number): void {
  const { index, vectors, lexical } = snapshot;
  if (index.projects.length !== 1 || index.projects[0].id !== projectId) throw new Error('Inconsistent project identity');
  const files = unique(index.files, (f) => String(f.id), 'file ID');
  const paths = new Set(index.files.map((f) => String(f.relative_path)));
  for (const f of files.values()) {
    assertAllowedPath(String(f.relative_path));
    if (f.id !== stableId(projectId, String(f.relative_path))) throw new Error('Unsupported file ID algorithm');
    if (!/^[a-f0-9]{64}$/.test(String(f.sha256))) throw new Error('Invalid indexed file SHA-256');
  }
  for (const table of ['symbols', 'imports', 'exports'] as const) {
    for (const row of index[table]) if (!files.has(String(row.file_id))) throw new Error(`Orphan ${table} file_id`);
  }
  for (const row of index.relations) {
    assertAllowedPath(String(row.from_path)); assertAllowedPath(String(row.to_path));
    if (!paths.has(String(row.from_path)) || !paths.has(String(row.to_path))) throw new Error('Orphan relation');
  }
  for (const row of index.annotations) assertAllowedPath(String(row.relative_path));
  const chunks = unique(index.chunks, (c) => String(c.chunk_id), 'chunk ID');
  const points = unique(vectors.points, (p) => p.payload.chunk_id, 'point chunk ID');
  unique(vectors.points, (p) => p.id, 'point UUID');
  const docs = unique(lexical.documents, (d) => d.chunk_id, 'document chunk ID');
  // Check every remote path before checking membership; forbidden orphan records also refuse the dump.
  for (const record of [...vectors.points.map((p) => p.payload), ...lexical.documents]) assertAllowedPath(record.path);
  if (chunks.size !== points.size || chunks.size !== docs.size) throw new Error('chunkId sets differ: missing or extra points/documents');
  const config = vectors.parameters.vectors as { size?: number; distance?: string } | undefined;
  if (config?.size !== dimensions) throw new Error('Collection dimensions differ from embedding provenance');
  for (const c of chunks.values()) {
    if (c.embedded !== 1) throw new Error('Pending embeddings; snapshot refused');
    const f = files.get(String(c.file_id)), p = points.get(String(c.chunk_id)), d = docs.get(String(c.chunk_id));
    if (!f || !p || !d) throw new Error(`chunkId sets differ: ${c.chunk_id}`);
    if (sha256(String(c.content)) !== c.content_hash) throw new Error('Chunk content hash mismatch');
    if (p.id !== toUuid(String(c.chunk_id))) throw new Error('Point UUID mismatch');
    if (p.vector.length !== dimensions || p.vector.some((v) => !Number.isFinite(v) || !Number.isFinite(Math.fround(v)))) throw new Error('Invalid vector dimensions or non-finite values');
    const expected = { project_id: projectId, file_id: f.id, path: f.relative_path, symbol: c.symbol,
      chunk_type: c.chunk_type, content_hash: c.content_hash, line_start: c.line_start, line_end: c.line_end, git_commit: f.git_commit };
    for (const [key, value] of Object.entries(expected)) {
      if ((p.payload as unknown as Row)[key] !== value || (d as unknown as Row)[key] !== value) throw new Error(`Inconsistent payload ${c.chunk_id}: ${key}`);
    }
    if (d.id !== c.chunk_id || d.content !== c.content || d.summary !== p.payload.summary ||
      p.payload.updated_at !== f.indexed_at || d.updated_at !== Date.parse(String(f.indexed_at))) throw new Error(`Inconsistent document ${c.chunk_id}`);
  }
  idParameters(index);
}

export function logicalSummary(snapshot: Snapshot): Pick<DumpManifestBody, 'counts' | 'logicalHashes'> {
  const contents: Record<string, unknown[]> = { ...snapshot.index,
    points: snapshot.vectors.points.map((p) => ({ ...p, vector: p.vector.map(Math.fround) })), documents: snapshot.lexical.documents };
  const counts: Record<string, number> = {}, logicalHashes: Record<string, string> = {};
  for (const [table, rows] of Object.entries(contents)) {
    counts[table] = rows.length;
    logicalHashes[table] = sha256(canonicalJson(rows.map((r) => canonicalJson(r)).sort()));
  }
  return { counts, logicalHashes };
}

export function validateRelativeReferences(index: LogicalIndex): void {
  for (const table of Object.keys(index) as Table[]) for (const row of index[table]) {
    for (const key of ['relative_path', 'from_path', 'to_path']) if (row[key] !== undefined) assertPortablePath(String(row[key]));
  }
}
