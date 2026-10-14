export type ChunkType =
  | 'function' | 'class' | 'method' | 'interface' | 'export'
  | 'doc_section' | 'config' | 'lines';

export interface FileRecord {
  id: string;
  path: string;
  relativePath: string;
  language: string;
  size: number;
  sha256: string;
  mtimeMs: number;
  gitBranch: string;
  gitCommit: string;
  isTest: boolean;
  isDocumentation: boolean;
  isConfig: boolean;
  indexedAt: string;
  indexVersion: number;
}

export interface Chunk {
  chunkId: string;
  fileId: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  symbol: string;
  chunkType: ChunkType;
  content: string;
  contentHash: string;
  language: string;
  imports: string[];
  exports: string[];
  relatedPaths: string[];
}

export interface SymbolRecord {
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  exported: boolean;
}

export interface Relation {
  fromPath: string;
  toPath: string;
  kind: 'import' | 'test' | 'doc' | 'module' | 'package';
}

export interface SearchHit {
  chunkId: string;
  fileId: string;
  path: string;
  symbol: string;
  chunkType: string;
  language: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  lexicalScore: number;
  semanticScore: number;
  snippet?: string;
  annotation?: string;
  indexed_at: string;
  content_hash: string;
  is_stale: boolean;
  git_commit: string;
}

export interface Annotation {
  relativePath: string;
  summary: string;
  role: string;
  contentHash: string;
  author: string;
  updatedAt: string;
}

export type SearchMode = 'hybrid' | 'lexical' | 'semantic';
export const INDEX_VERSION = 1;
