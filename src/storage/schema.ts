export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, relative_path TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, mtime_ms INTEGER NOT NULL,
  git_branch TEXT NOT NULL, git_commit TEXT NOT NULL,
  is_test INTEGER NOT NULL, is_documentation INTEGER NOT NULL, is_config INTEGER NOT NULL,
  indexed_at TEXT NOT NULL, index_version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'indexed'
);
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT PRIMARY KEY, file_id TEXT NOT NULL, line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL, symbol TEXT NOT NULL, chunk_type TEXT NOT NULL,
  content_hash TEXT NOT NULL, embedded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
CREATE TABLE IF NOT EXISTS symbols (
  file_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  line_start INTEGER NOT NULL, line_end INTEGER NOT NULL, exported INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE TABLE IF NOT EXISTS imports (file_id TEXT NOT NULL, specifier TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
CREATE TABLE IF NOT EXISTS exports (file_id TEXT NOT NULL, name TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_exports_file ON exports(file_id);
CREATE TABLE IF NOT EXISTS relations (
  from_path TEXT NOT NULL, to_path TEXT NOT NULL, kind TEXT NOT NULL,
  PRIMARY KEY (from_path, to_path, kind)
);
CREATE INDEX IF NOT EXISTS idx_rel_to ON relations(to_path);
CREATE TABLE IF NOT EXISTS index_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, files_indexed INTEGER NOT NULL DEFAULT 0, files_removed INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS index_errors (
  path TEXT NOT NULL, message TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS annotations (
  relative_path TEXT PRIMARY KEY, summary TEXT NOT NULL, role TEXT NOT NULL,
  content_hash TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'agent', updated_at TEXT NOT NULL
);
`;
