import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA } from './schema.js';
import type { Annotation, Chunk, FileRecord, Relation, SymbolRecord } from '../shared/types.js';
import { assertSourceReady, readIndex } from '../transfer/sqlite.js';
import { withMemoryLockSync } from './memory-lock.js';

type Row = Record<string, string | number | null>;

function enableWal(db: DatabaseSync): void {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/database (?:is )?locked/i.test(message) || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export interface PendingChunk {
  chunkId: string; fileId: string; relativePath: string; language: string; symbol: string; chunkType: string;
  lineStart: number; lineEnd: number; contentHash: string; content: string; gitCommit: string; indexedAt: string; summary: string;
}

const toAnnotation = (r: Row): Annotation => ({
  relativePath: r.relative_path as string, summary: r.summary as string, role: r.role as string,
  contentHash: r.content_hash as string, author: r.author as string, updatedAt: r.updated_at as string,
  ...(r.file_status === 'stale' ? { isStale: true } : {}),
});

const toFile = (r: Row): FileRecord => ({
  id: r.id as string, path: r.path as string, relativePath: r.relative_path as string,
  language: r.language as string, size: r.size as number, sha256: r.sha256 as string,
  mtimeMs: r.mtime_ms as number, gitBranch: r.git_branch as string, gitCommit: r.git_commit as string,
  isTest: !!r.is_test, isDocumentation: !!r.is_documentation, isConfig: !!r.is_config,
  indexedAt: r.indexed_at as string, indexVersion: r.index_version as number,
  ...(r.status !== 'indexed' ? { status: r.status as FileRecord['status'] } : {}),
});

/** Canonical local manifest. Qdrant and Typesense are derived from it and can be rebuilt. */
export class Manifest {
  private readonly db: DatabaseSync;

  readonly generationId?: string;
  readonly annotationsFile?: string;
  constructor(readonly filePath: string, generation?: { id: string; annotationsPath: string }) {
    const file = filePath;
    this.generationId = generation?.id;
    this.annotationsFile = generation?.annotationsPath;
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { timeout: 5000 });
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;');
    enableWal(this.db);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.exec(SCHEMA);
      if (!this.all('PRAGMA table_info(chunks)').some((c) => c.name === 'content')) {
        this.db.exec("ALTER TABLE chunks ADD COLUMN content TEXT NOT NULL DEFAULT ''");
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  close(): void { this.db.close(); }

  transferSnapshot() { assertSourceReady(this.db); return readIndex(this.db); }

  private all(sql: string, ...params: Array<string | number>): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private run(sql: string, ...params: Array<string | number | null>): void {
    // Imported generations track every local manifest write, including annotation/job changes.
    // Set this first so a process death between statements cannot hide a completed mutation.
    this.db.prepare("UPDATE meta SET value='1' WHERE key='import_dirty'").run();
    this.db.prepare(sql).run(...params);
  }

  tx<T>(fn: () => T, immediate = false): T {
    this.db.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const v = fn(); this.db.exec('COMMIT'); return v; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  ensureProject(id: string, name: string, root: string): void {
    if (this.all('SELECT id FROM projects WHERE id=?', id).length) return;
    withMemoryLockSync(root, () => this.run('INSERT OR IGNORE INTO projects(id,name,root,created_at) VALUES(?,?,?,?)', id, name, root, new Date().toISOString()));
  }

  getMeta(key: string): string | undefined {
    return this.all('SELECT value FROM meta WHERE key=?', key)[0]?.value as string | undefined;
  }
  setMeta(key: string, value: string): void {
    this.run('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
  }
  deleteMeta(key: string): void { this.run('DELETE FROM meta WHERE key=?', key); }

  pruneIndexJobs(retain: number, protectedJobId?: string): string[] {
    return this.all(`DELETE FROM meta WHERE key IN (
      SELECT key FROM meta WHERE key GLOB 'index_job:*'
      AND json_extract(value, '$.state') IN ('completed', 'failed', 'interrupted')
      AND key <> 'index_job:' || COALESCE((SELECT value FROM meta WHERE key='active_index_job'), '')
      AND key <> 'index_job:' || COALESCE(?, '')
      ORDER BY json_extract(value, '$.heartbeat') DESC, rowid DESC LIMIT -1 OFFSET ?
    ) RETURNING value`, protectedJobId ?? '', retain).flatMap((row) => {
      const job = JSON.parse(row.value as string) as { log_path?: string | null };
      return job.log_path ? [job.log_path] : [];
    });
  }

  listFiles(): FileRecord[] { return this.all('SELECT * FROM files ORDER BY relative_path').map(toFile); }
  getFile(rel: string): FileRecord | undefined {
    const r = this.all('SELECT * FROM files WHERE relative_path=?', rel)[0];
    return r ? toFile(r) : undefined;
  }
  getFileById(id: string): FileRecord | undefined {
    const r = this.all('SELECT * FROM files WHERE id=?', id)[0];
    return r ? toFile(r) : undefined;
  }

  upsertFile(f: FileRecord): void {
    this.run(
      `INSERT INTO files(id,path,relative_path,language,size,sha256,mtime_ms,git_branch,git_commit,is_test,is_documentation,is_config,indexed_at,index_version,status)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'indexed')
       ON CONFLICT(id) DO UPDATE SET path=excluded.path, relative_path=excluded.relative_path, language=excluded.language,
         size=excluded.size, sha256=excluded.sha256, mtime_ms=excluded.mtime_ms, git_branch=excluded.git_branch,
         git_commit=excluded.git_commit, is_test=excluded.is_test, is_documentation=excluded.is_documentation,
         is_config=excluded.is_config, indexed_at=excluded.indexed_at, index_version=excluded.index_version, status='indexed'`,
      f.id, f.path, f.relativePath, f.language, f.size, f.sha256, f.mtimeMs, f.gitBranch, f.gitCommit,
      +f.isTest, +f.isDocumentation, +f.isConfig, f.indexedAt, f.indexVersion,
    );
  }

  touchFile(id: string, mtimeMs: number, gitCommit: string, gitBranch: string): void {
    this.run('UPDATE files SET mtime_ms=?, git_commit=?, git_branch=? WHERE id=?', mtimeMs, gitCommit, gitBranch, id);
  }

  deleteFile(id: string): void {
    for (const t of ['chunks', 'symbols', 'imports', 'exports']) this.run(`DELETE FROM ${t} WHERE file_id=?`, id);
    const f = this.getFileById(id);
    if (f) {
      this.run('DELETE FROM relations WHERE from_path=?', f.relativePath);
      this.run('DELETE FROM annotations WHERE relative_path=?', f.relativePath);
    }
    this.run('DELETE FROM files WHERE id=?', id);
  }

  chunkIds(fileId: string): Array<{ chunkId: string; embedded: boolean }> {
    return this.all('SELECT chunk_id, embedded FROM chunks WHERE file_id=?', fileId)
      .map((r) => ({ chunkId: r.chunk_id as string, embedded: !!r.embedded }));
  }

  replaceChunks(fileId: string, chunks: Chunk[], embedded: Set<string>): void {
    this.run('DELETE FROM chunks WHERE file_id=?', fileId);
    for (const c of chunks) {
      this.run(
        'INSERT INTO chunks(chunk_id,file_id,line_start,line_end,symbol,chunk_type,content_hash,embedded,content) VALUES(?,?,?,?,?,?,?,?,?)',
        c.chunkId, fileId, c.lineStart, c.lineEnd, c.symbol, c.chunkType, c.contentHash, embedded.has(c.chunkId) ? 1 : 0, c.content,
      );
    }
  }

  pathsWithUnembedded(): string[] {
    return this.all(
      `SELECT DISTINCT f.relative_path FROM chunks c JOIN files f ON f.id=c.file_id WHERE c.embedded=0`,
    ).map((r) => r.relative_path as string);
  }

  pendingEmbeddings(): number {
    return this.all('SELECT COUNT(*) AS n FROM chunks WHERE embedded=0')[0].n as number;
  }

  markEmbedded(chunkIds: string[]): void {
    for (const id of chunkIds) this.run('UPDATE chunks SET embedded=1 WHERE chunk_id=?', id);
  }

  unembeddedChunks(limit: number): PendingChunk[] {
    return this.all(
      `SELECT c.chunk_id, c.file_id, c.symbol, c.chunk_type, c.line_start, c.line_end, c.content_hash, c.content,
         f.relative_path, f.language, f.git_commit, f.indexed_at,
         CASE WHEN a.content_hash=f.sha256 THEN a.summary ELSE '' END AS summary
       FROM chunks c JOIN files f ON f.id=c.file_id LEFT JOIN annotations a ON a.relative_path=f.relative_path
       WHERE c.embedded=0 ORDER BY c.rowid LIMIT ?`, limit,
    ).map((r) => ({
      chunkId: r.chunk_id as string, fileId: r.file_id as string, relativePath: r.relative_path as string,
      language: r.language as string, symbol: r.symbol as string, chunkType: r.chunk_type as string,
      lineStart: r.line_start as number, lineEnd: r.line_end as number, contentHash: r.content_hash as string,
      content: r.content as string, gitCommit: r.git_commit as string, indexedAt: r.indexed_at as string,
      summary: r.summary as string,
    }));
  }

  markChunksEmbedded(chunkIds: string[]): void {
    this.tx(() => this.markEmbedded(chunkIds));
  }

  replaceStructure(fileId: string, symbols: SymbolRecord[], imports: string[], exports: string[]): void {
    for (const t of ['symbols', 'imports', 'exports']) this.run(`DELETE FROM ${t} WHERE file_id=?`, fileId);
    for (const s of symbols) {
      this.run('INSERT INTO symbols VALUES(?,?,?,?,?,?)', fileId, s.name, s.kind, s.lineStart, s.lineEnd, +s.exported);
    }
    for (const i of imports) this.run('INSERT INTO imports VALUES(?,?)', fileId, i);
    for (const e of exports) this.run('INSERT INTO exports VALUES(?,?)', fileId, e);
  }

  symbolsOf(fileId: string): SymbolRecord[] {
    return this.all('SELECT * FROM symbols WHERE file_id=? ORDER BY line_start', fileId).map((r) => ({
      name: r.name as string, kind: r.kind as string, lineStart: r.line_start as number,
      lineEnd: r.line_end as number, exported: !!r.exported,
    }));
  }
  importsOf(fileId: string): string[] {
    return this.all('SELECT specifier FROM imports WHERE file_id=?', fileId).map((r) => r.specifier as string);
  }
  exportsOf(fileId: string): string[] {
    return this.all('SELECT name FROM exports WHERE file_id=?', fileId).map((r) => r.name as string);
  }
  findSymbols(name: string, limit = 20): Array<{ name: string; kind: string; path: string; lineStart: number }> {
    return this.all(
      `SELECT s.name, s.kind, s.line_start, f.relative_path FROM symbols s JOIN files f ON f.id=s.file_id
       WHERE s.name LIKE ? ORDER BY s.exported DESC LIMIT ?`, `%${name}%`, limit,
    ).map((r) => ({ name: r.name as string, kind: r.kind as string, path: r.relative_path as string, lineStart: r.line_start as number }));
  }

  replaceRelations(fromPath: string, relations: Relation[]): void {
    this.run('DELETE FROM relations WHERE from_path=?', fromPath);
    for (const r of relations) this.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', r.fromPath, r.toPath, r.kind);
  }
  relationsFrom(path: string): Relation[] { return this.rel('from_path', path); }
  relationsTo(path: string): Relation[] { return this.rel('to_path', path); }
  private rel(col: string, path: string): Relation[] {
    return this.all(`SELECT * FROM relations WHERE ${col}=?`, path).map((r) => ({
      fromPath: r.from_path as string, toPath: r.to_path as string, kind: r.kind as Relation['kind'],
    }));
  }

  startRun(kind: string): number {
    this.run('INSERT INTO index_runs(kind,started_at) VALUES(?,?)', kind, new Date().toISOString());
    return this.all('SELECT last_insert_rowid() AS id')[0].id as number;
  }
  finishRun(id: number, indexed: number, removed: number, errors: number): void {
    this.run('UPDATE index_runs SET finished_at=?, files_indexed=?, files_removed=?, errors=? WHERE id=?',
      new Date().toISOString(), indexed, removed, errors, id);
    this.setMeta('last_sync_at', new Date().toISOString());
  }
  lastRuns(limit = 5): Row[] { return this.all('SELECT * FROM index_runs ORDER BY id DESC LIMIT ?', limit); }

  recordError(path: string, message: string): void {
    this.run('DELETE FROM index_errors WHERE path=?', path);
    this.run('INSERT INTO index_errors VALUES(?,?,?)', path, message, new Date().toISOString());
  }
  clearError(path: string): void { this.run('DELETE FROM index_errors WHERE path=?', path); }
  errors(limit = 20): Array<{ path: string; message: string; at: string }> {
    return this.all('SELECT * FROM index_errors ORDER BY at DESC LIMIT ?', limit) as never;
  }

  counts(): { files: number; chunks: number; errors: number } {
    const n = (t: string) => this.all(`SELECT COUNT(*) AS n FROM ${t}`)[0].n as number;
    return { files: n('files'), chunks: n('chunks'), errors: n('index_errors') };
  }

  recentFiles(limit = 10): FileRecord[] {
    return this.all('SELECT * FROM files ORDER BY indexed_at DESC LIMIT ?', limit).map(toFile);
  }

  upsertAnnotation(a: Annotation): void {
    this.run(
      `INSERT INTO annotations(relative_path,summary,role,content_hash,author,updated_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(relative_path) DO UPDATE SET summary=excluded.summary, role=excluded.role,
         content_hash=excluded.content_hash, author=excluded.author, updated_at=excluded.updated_at`,
      a.relativePath, a.summary, a.role, a.contentHash, a.author, a.updatedAt,
    );
  }

  getAnnotation(relativePath: string): Annotation | undefined {
    const r = this.all('SELECT a.*, f.status AS file_status FROM annotations a LEFT JOIN files f ON f.relative_path=a.relative_path WHERE a.relative_path=?', relativePath)[0];
    return r ? toAnnotation(r) : undefined;
  }

  listAnnotations(): Annotation[] {
    return this.all('SELECT a.*, f.status AS file_status FROM annotations a LEFT JOIN files f ON f.relative_path=a.relative_path ORDER BY a.relative_path').map(toAnnotation);
  }

  /** Files without an annotation, or whose annotation was written for an older content hash. */
  pendingAnnotations(limit = 20): Array<{ relativePath: string; sha256: string }> {
    return this.all(
      `SELECT f.relative_path, f.sha256 FROM files f LEFT JOIN annotations a ON a.relative_path=f.relative_path
       WHERE a.relative_path IS NULL OR a.content_hash<>f.sha256 OR f.status='stale' ORDER BY f.relative_path LIMIT ?`, limit,
    ).map((r) => ({ relativePath: r.relative_path as string, sha256: r.sha256 as string }));
  }

  deleteAnnotation(relativePath: string): void {
    this.run('DELETE FROM annotations WHERE relative_path=?', relativePath);
  }

  resetDerivedState(): void {
    this.run('UPDATE chunks SET embedded=0');
    this.run('DELETE FROM files');
    for (const t of ['chunks', 'symbols', 'imports', 'exports', 'relations']) this.run(`DELETE FROM ${t}`);
  }
}
