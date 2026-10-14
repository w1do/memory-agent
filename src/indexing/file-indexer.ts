import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { MemoryContext } from '../shared/context.js';
import { INDEX_VERSION, type Chunk, type FileRecord } from '../shared/types.js';
import { sha256, stableId } from '../shared/hash.js';
import { redact } from '../security/redact.js';
import { gitBranch, gitCommit } from '../project/git.js';
import { isConfig, isDocumentation, isTestFile } from '../project/classify.js';
import { chunkFile, extractSymbols } from './chunker.js';
import { extractDocLinks, extractExports, extractImports, extractPackageDeps } from './extract.js';
import { buildRelations, nonTestStems, PathIndex } from './relations.js';
import type { QdrantPayload } from '../storage/qdrant.js';

export interface IndexInput { relativePath: string; absolutePath: string; mtimeMs: number; language: string }
export type IndexOutcome = 'indexed' | 'skipped';

export interface PayloadFile { id: string; relativePath: string; language: string; gitCommit: string; indexedAt: string }
export interface PayloadChunk { chunkId: string; symbol: string; chunkType: string; lineStart: number; lineEnd: number; contentHash: string }

export const toPayload = (projectId: string, file: PayloadFile, c: PayloadChunk, summary: string): QdrantPayload => {
  const slash = file.relativePath.lastIndexOf('/');
  return {
    project_id: projectId, chunk_id: c.chunkId, file_id: file.id, path: file.relativePath,
    file_name: file.relativePath.slice(slash + 1), directory: slash >= 0 ? file.relativePath.slice(0, slash) : '.',
    language: file.language, symbol: c.symbol, chunk_type: c.chunkType, line_start: c.lineStart,
    line_end: c.lineEnd, content_hash: c.contentHash, git_commit: file.gitCommit, updated_at: file.indexedAt,
    summary,
  };
};

/** Indexes files one by one into SQLite and Typesense; embeddings are produced later in the batched phase. */
export class FileIndexer {
  private pathIndex = new PathIndex([]);
  private stems = new Map<string, string[]>();
  private readonly branch: string;
  private readonly commit: string;

  constructor(private readonly ctx: MemoryContext) {
    this.branch = gitBranch(ctx.root);
    this.commit = gitCommit(ctx.root);
  }

  setKnownPaths(files: FileRecord[], extra: string[]): void {
    this.pathIndex = new PathIndex([...new Set([...files.map((f) => f.relativePath), ...extra])]);
    this.stems = nonTestStems(files);
  }

  async index(input: IndexInput): Promise<IndexOutcome> {
    const { manifest, config } = this.ctx;
    const buffer = readFileSync(input.absolutePath);
    if (buffer.includes(0)) return 'skipped';

    const rel = input.relativePath;
    const text = redact(buffer.toString('utf8'));
    const file = this.toRecord(input, buffer, rel);
    const summary = this.summaryOf(file);
    const chunks = this.toChunks(file, text);
    const imports = this.importsOf(file, text);
    const exports = extractExports(file.language, text);
    const symbols = extractSymbols(file.language, text);
    const relations = buildRelations(file, imports, this.pathIndex, this.stems);
    const relatedPaths = [...new Set(relations.map((r) => r.toPath))].slice(0, 20);
    chunks.forEach((c) => { c.relatedPaths = relatedPaths; c.imports = imports.slice(0, 30); c.exports = exports.slice(0, 30); });

    const previous = new Map(manifest.chunkIds(file.id).map((c) => [c.chunkId, c.embedded]));
    const stale = [...previous.keys()].filter((id) => !chunks.some((c) => c.chunkId === id));

    await this.ctx.typesense.deleteChunks(stale);
    await this.ctx.qdrant.deleteChunks(stale);
    await this.ctx.typesense.upsert(this.ctx.typesense.toDocs(file, chunks, symbols.map((s) => s.name), config.projectId, summary));
    await this.refreshPayloads(file, chunks.filter((c) => previous.get(c.chunkId)), summary);

    manifest.tx(() => {
      manifest.upsertFile(file);
      const done = new Set([...previous].filter(([, e]) => e).map(([id]) => id));
      manifest.replaceChunks(file.id, chunks, done);
      manifest.replaceStructure(file.id, symbols, imports, exports);
      manifest.replaceRelations(rel, relations);
      manifest.clearError(rel);
    });
    return 'indexed';
  }

  private toRecord(input: IndexInput, buffer: Buffer, rel: string): FileRecord {
    const { config } = this.ctx;
    return {
      id: stableId(config.projectId, rel), path: input.absolutePath, relativePath: rel,
      language: input.language, size: buffer.length, sha256: sha256(buffer), mtimeMs: input.mtimeMs,
      gitBranch: this.branch, gitCommit: this.commit, isTest: isTestFile(rel),
      isDocumentation: isDocumentation(rel, input.language), isConfig: isConfig(rel, input.language),
      indexedAt: new Date().toISOString(), indexVersion: INDEX_VERSION,
    };
  }

  private toChunks(file: FileRecord, text: string): Chunk[] {
    const seen = new Map<string, number>();
    return chunkFile(file.language, text, file.isConfig).map((raw) => {
      const contentHash = sha256(raw.content);
      const key = `${raw.symbol}|${contentHash}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return {
        chunkId: stableId(file.id, key, String(n)), fileId: file.id, path: file.relativePath,
        lineStart: raw.lineStart, lineEnd: raw.lineEnd, symbol: raw.symbol, chunkType: raw.chunkType,
        content: raw.content, contentHash, language: file.language, imports: [], exports: [], relatedPaths: [],
      };
    });
  }

  /** Agent annotation is used only while it matches the current content hash. */
  private summaryOf(file: FileRecord): string {
    const annotation = this.ctx.manifest.getAnnotation(file.relativePath);
    return annotation && annotation.contentHash === file.sha256 ? annotation.summary : '';
  }

  private importsOf(file: FileRecord, text: string): string[] {
    if (basename(file.relativePath) === 'package.json') return extractPackageDeps(text);
    if (file.language === 'markdown') return extractDocLinks(text);
    return extractImports(file.language, text);
  }

  /** Keeps vector payloads of already embedded chunks in sync; best-effort, a failure must not stop indexing. */
  private async refreshPayloads(file: FileRecord, kept: Chunk[], summary: string): Promise<void> {
    if (!kept.length) return;
    try {
      await this.ctx.qdrant.updatePayloads(kept.map((c) => ({ chunkId: c.chunkId, payload: toPayload(this.ctx.config.projectId, file, c, summary) })));
    } catch (e) {
      this.ctx.logger.warn(`payload_refresh_failed: ${redact((e as Error).message)}`);
    }
  }
}
