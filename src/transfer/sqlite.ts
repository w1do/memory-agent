import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../storage/schema.js';
import { canonicalJson } from './manifest.js';

export type Row = Record<string, string | number | null>;
export const COLUMNS = {
  meta: 'key,value', projects: 'id,name,root,created_at',
  files: 'id,path,relative_path,language,size,sha256,mtime_ms,git_branch,git_commit,is_test,is_documentation,is_config,indexed_at,index_version,status',
  chunks: 'chunk_id,file_id,line_start,line_end,symbol,chunk_type,content_hash,embedded,content',
  symbols: 'file_id,name,kind,line_start,line_end,exported', imports: 'file_id,specifier', exports: 'file_id,name',
  relations: 'from_path,to_path,kind', annotations: 'relative_path,summary,role,content_hash,author,updated_at',
} as const;
export type Table = keyof typeof COLUMNS;
export type LogicalIndex = Record<Table, Row[]>;
const metadata = new Set(['embedding_fingerprint', 'last_sync_at']);

export function readIndex(db: DatabaseSync): LogicalIndex {
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('SQLite integrity_check failed');
  return Object.fromEntries(Object.entries(COLUMNS).map(([table, columns]) => {
    let rows = db.prepare(`SELECT ${columns} FROM ${table}`).all().map((row) => ({ ...row })) as Row[];
    if (table === 'meta') rows = rows.filter((r) => metadata.has(String(r.key)));
    return [table, rows.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b), 'en'))];
  })) as LogicalIndex;
}

/** Build fresh pages; never copy source freelists, errors, jobs, WAL or unknown metadata. */
export function writeIndex(file: string, index: LogicalIndex): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(SCHEMA.split(';').filter((s) => !/\b(index_runs|index_errors)\b/.test(s)).join(';'));
    db.exec('BEGIN');
    for (const table of Object.keys(COLUMNS) as Table[]) {
      const columns = COLUMNS[table].split(',');
      const stmt = db.prepare(`INSERT INTO ${table}(${columns}) VALUES(${columns.map(() => '?').join(',')})`);
      for (const row of index[table]) stmt.run(...columns.map((c) => row[c]));
    }
    db.exec('COMMIT');
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('SQLite integrity_check failed');
  } finally { db.close(); }
}

export function assertSourceReady(db: DatabaseSync): void {
  for (const { value } of db.prepare("SELECT value FROM meta WHERE key GLOB 'index_job:*'").all()) {
    if (['queued', 'running'].includes(JSON.parse(String(value)).state)) throw new Error('Unfinished index job; snapshot refused');
  }
  if (Number(db.prepare('SELECT count(*) AS n FROM index_errors').get()?.n)) throw new Error('Index errors; snapshot refused');
  if (Number(db.prepare('SELECT count(*) AS n FROM index_runs WHERE finished_at IS NULL').get()?.n)) throw new Error('Unfinished index run');
}
