import Typesense from 'typesense';
import type { Chunk, FileRecord } from '../shared/types.js';

export interface TsDoc {
  id: string;
  chunk_id: string;
  file_id: string;
  project_id: string;
  path: string;
  file_name: string;
  directory: string;
  language: string;
  symbol: string;
  symbols: string[];
  imports: string[];
  exports: string[];
  title: string;
  content: string;
  chunk_type: string;
  is_test: boolean;
  is_documentation: boolean;
  git_branch: string;
  git_commit: string;
  content_hash: string;
  line_start: number;
  line_end: number;
  updated_at: number;
}

export interface TsHit { doc: TsDoc; score: number }

export interface TypesenseOptions { host: string; port: number; apiKey: string; collection: string }

export class TypesenseStore {
  private readonly client: InstanceType<typeof Typesense.Client>;

  constructor(private readonly opts: TypesenseOptions) {
    this.client = new Typesense.Client({
      nodes: [{ host: opts.host, port: opts.port, protocol: 'http' }],
      apiKey: opts.apiKey,
      connectionTimeoutSeconds: 5,
    });
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const h = await this.client.health.retrieve();
      return { ok: !!h.ok, detail: h.ok ? 'ready' : 'unhealthy' };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async ensureCollection(): Promise<void> {
    const exists = await this.client.collections(this.opts.collection).exists();
    if (exists) return;
    await this.client.collections().create({
      name: this.opts.collection,
      token_separators: ['-', '_', '.', '/'],
      fields: [
        { name: 'chunk_id', type: 'string', index: false, optional: true },
        { name: 'file_id', type: 'string', facet: true },
        { name: 'project_id', type: 'string', facet: true },
        { name: 'path', type: 'string' },
        { name: 'file_name', type: 'string' },
        { name: 'directory', type: 'string', facet: true },
        { name: 'language', type: 'string', facet: true },
        { name: 'symbol', type: 'string' },
        { name: 'symbols', type: 'string[]' },
        { name: 'imports', type: 'string[]' },
        { name: 'exports', type: 'string[]' },
        { name: 'title', type: 'string' },
        { name: 'content', type: 'string' },
        { name: 'chunk_type', type: 'string', facet: true },
        { name: 'is_test', type: 'bool' },
        { name: 'is_documentation', type: 'bool' },
        { name: 'git_branch', type: 'string', index: false },
        { name: 'git_commit', type: 'string', index: false },
        { name: 'content_hash', type: 'string', index: false },
        { name: 'line_start', type: 'int32', index: false },
        { name: 'line_end', type: 'int32', index: false },
        { name: 'updated_at', type: 'int64' },
      ],
    });
  }

  async dropCollection(): Promise<void> {
    if (await this.client.collections(this.opts.collection).exists()) {
      await this.client.collections(this.opts.collection).delete();
    }
  }

  toDocs(file: FileRecord, chunks: Chunk[], symbols: string[], projectId: string): TsDoc[] {
    const slash = file.relativePath.lastIndexOf('/');
    return chunks.map((c) => ({
      id: c.chunkId, chunk_id: c.chunkId, file_id: file.id, project_id: projectId,
      path: file.relativePath,
      file_name: file.relativePath.slice(slash + 1),
      directory: slash >= 0 ? file.relativePath.slice(0, slash) : '.',
      language: file.language, symbol: c.symbol, symbols: symbols,
      imports: c.imports, exports: c.exports,
      title: c.symbol || file.relativePath.slice(slash + 1),
      content: c.content, chunk_type: c.chunkType,
      is_test: file.isTest, is_documentation: file.isDocumentation,
      git_branch: file.gitBranch, git_commit: file.gitCommit, content_hash: c.contentHash,
      line_start: c.lineStart, line_end: c.lineEnd, updated_at: Date.parse(file.indexedAt),
    }));
  }

  async upsert(docs: TsDoc[]): Promise<void> {
    if (!docs.length) return;
    const res = await this.client.collections(this.opts.collection).documents().import(docs, { action: 'upsert' });
    const failed = res.filter((r) => !r.success);
    if (failed.length) throw new Error(`Typesense import failed: ${failed[0].error}`);
  }

  async deleteByFile(fileId: string): Promise<void> {
    await this.client.collections(this.opts.collection).documents().delete({ filter_by: `file_id:=${fileId}` });
  }

  async deleteChunks(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.client.collections(this.opts.collection).documents(id).delete().catch(() => undefined);
    }
  }

  async count(): Promise<number> {
    return (await this.client.collections(this.opts.collection).retrieve()).num_documents;
  }

  async search(query: string, limit: number, language?: string): Promise<TsHit[]> {
    const res = await this.client.collections<TsDoc>(this.opts.collection).documents().search({
      q: query || '*',
      query_by: 'path,symbol,file_name,symbols,exports,imports,title,content',
      query_by_weights: '10,9,8,5,5,4,3,2',
      prefix: 'true,true,true,true,true,true,true,false',
      num_typos: 1,
      drop_tokens_threshold: 5,
      per_page: limit,
      filter_by: language ? `language:=${language}` : undefined,
    } as never);
    return (res.hits ?? []).map((h) => ({ doc: h.document as TsDoc, score: Number(h.text_match ?? 0) }));
  }

  async contentOf(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of ids) {
      const d = await this.client.collections<TsDoc>(this.opts.collection).documents(id).retrieve().catch(() => null);
      if (d) out.set(id, (d as TsDoc).content);
    }
    return out;
  }
}
