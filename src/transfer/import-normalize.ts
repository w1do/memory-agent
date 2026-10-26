import type { IdMap } from './import-rebind.js';
import type { Snapshot } from './types.js';

/** Undo only documented local bindings; preserve all other values for hashing. */
export function sourceBindings(snapshot: Snapshot, source: Snapshot, ids: IdMap): Snapshot {
  const result = structuredClone(snapshot);
  const inverse = (map: Record<string, string>) => {
    const reversed = new Map(Object.entries(map).map(([from, to]) => [to, from]));
    if (reversed.size !== Object.keys(map).length) throw new Error('Non-bijective ID map');
    return (id: string) => {
      const original = reversed.get(id);
      if (original === undefined) throw new Error(`Unknown imported ID: ${id}`);
      return original;
    };
  };
  const project = inverse(ids.projects), file = inverse(ids.files), chunk = inverse(ids.chunks), point = inverse(ids.points);
  const sourceProjects = new Map(source.index.projects.map((p) => [p.id, p]));
  const sourceFiles = new Map(source.index.files.map((f) => [f.id, f]));
  for (const row of result.index.projects) {
    row.id = project(String(row.id));
    const original = sourceProjects.get(row.id)!;
    row.name = original.name; row.root = original.root;
  }
  for (const row of result.index.files) {
    row.id = file(String(row.id));
    const original = sourceFiles.get(row.id)!;
    row.path = original.path; row.mtime_ms = original.mtime_ms; row.status = original.status;
  }
  for (const row of result.index.chunks) { row.chunk_id = chunk(String(row.chunk_id)); row.file_id = file(String(row.file_id)); }
  for (const table of ['symbols', 'imports', 'exports'] as const) {
    for (const row of result.index[table]) row.file_id = file(String(row.file_id));
  }
  for (const p of result.vectors.points) {
    p.id = point(p.id);
    p.payload.project_id = project(p.payload.project_id);
    p.payload.file_id = file(p.payload.file_id); p.payload.chunk_id = chunk(p.payload.chunk_id);
  }
  for (const d of result.lexical.documents) {
    d.id = chunk(d.id); d.chunk_id = chunk(d.chunk_id);
    d.project_id = project(d.project_id); d.file_id = file(d.file_id);
  }
  return result;
}
