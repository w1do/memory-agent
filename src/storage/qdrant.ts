import { QdrantClient } from '@qdrant/js-client-rest';
import { toUuid } from '../shared/hash.js';
import type { TransferPoint, VectorSnapshot, JsonObject } from '../transfer/types.js';

export interface QdrantPayload {
  project_id: string;
  chunk_id: string;
  file_id: string;
  path: string;
  file_name: string;
  directory: string;
  language: string;
  symbol: string;
  chunk_type: string;
  line_start: number;
  line_end: number;
  content_hash: string;
  git_commit: string;
  updated_at: string;
  summary: string;
}

export interface QdrantPoint { chunkId: string; vector: number[]; payload: QdrantPayload }
export interface QdrantHit { payload: QdrantPayload; score: number }

export class QdrantStore {
  private readonly client: QdrantClient;

  constructor(host: string, port: number, private readonly collection: string) {
    this.client = new QdrantClient({ host, port, https: false, checkCompatibility: false });
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.client.getCollections();
      return { ok: true, detail: 'ready' };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async exportSnapshot(): Promise<VectorSnapshot> {
    const info = await this.client.getCollection(this.collection);
    const version = await this.client.api().root({});
    const points: TransferPoint[] = [];
    let offset: NonNullable<Parameters<QdrantClient['scroll']>[1]>['offset'];
    do {
      const page = await this.client.scroll(this.collection, { limit: 256, offset, with_payload: true, with_vector: true });
      for (const p of page.points) {
        if (typeof p.id !== 'string' || !Array.isArray(p.vector)) throw new Error('Unsupported point ID or named/sparse vectors');
        points.push({ id: p.id, vector: p.vector as number[], payload: p.payload as unknown as QdrantPayload });
      }
      offset = page.next_page_offset ?? undefined;
    } while (offset !== undefined);
    points.sort((a, b) => a.id.localeCompare(b.id, 'en'));
    return { version: version.data.version, parameters: info.config.params as unknown as JsonObject, points };
  }

  async createFromSnapshot(parameters: JsonObject): Promise<void> {
    if (await this.exists()) throw new Error('Staging Qdrant collection already exists');
    await this.client.createCollection(this.collection, parameters as unknown as Parameters<QdrantClient['createCollection']>[1]);
  }

  async vectorSize(): Promise<number | null> {
    if (!(await this.exists())) return null;
    const info = await this.client.getCollection(this.collection);
    const v = info.config.params.vectors as { size?: number } | undefined;
    return v?.size ?? null;
  }

  private async exists(): Promise<boolean> {
    return (await this.client.collectionExists(this.collection)).exists;
  }

  /** Creates the collection; recreates it if the vector size changed. */
  async ensureCollection(size: number): Promise<void> {
    const current = await this.vectorSize();
    if (current === size) return;
    if (current !== null) await this.client.deleteCollection(this.collection);
    await this.client.createCollection(this.collection, { vectors: { size, distance: 'Cosine' } });
    for (const field of ['file_id', 'path', 'project_id']) {
      await this.client.createPayloadIndex(this.collection, { field_name: field, field_schema: 'keyword' });
    }
  }

  async dropCollection(): Promise<void> {
    if (await this.exists()) await this.client.deleteCollection(this.collection);
  }

  async upsert(points: QdrantPoint[]): Promise<void> {
    if (!points.length) return;
    await this.client.upsert(this.collection, {
      wait: true,
      points: points.map((p) => ({ id: toUuid(p.chunkId), vector: p.vector, payload: { ...p.payload } })),
    });
  }

  /** Refreshes metadata (line numbers, commit) of points whose vectors are unchanged. */
  async updatePayloads(items: Array<{ chunkId: string; payload: QdrantPayload }>): Promise<void> {
    for (const { chunkId, payload } of items) {
      await this.client.setPayload(this.collection, { wait: true, payload: { ...payload }, points: [toUuid(chunkId)] });
    }
  }

  async deleteByFile(fileId: string): Promise<void> {
    if (!(await this.exists())) return;
    await this.client.delete(this.collection, { wait: true, filter: { must: [{ key: 'file_id', match: { value: fileId } }] } });
  }

  async deleteChunks(chunkIds: string[]): Promise<void> {
    if (!chunkIds.length || !(await this.exists())) return;
    await this.client.delete(this.collection, { wait: true, points: chunkIds.map(toUuid) });
  }

  async count(): Promise<number> {
    if (!(await this.exists())) return 0;
    return (await this.client.count(this.collection, { exact: true })).count;
  }

  async search(vector: number[], limit: number, language?: string): Promise<QdrantHit[]> {
    const filter = language ? { must: [{ key: 'language', match: { value: language } }] } : undefined;
    const res = await this.client.query(this.collection, { query: vector, limit, filter, with_payload: true });
    return res.points.map((r) => ({ payload: r.payload as unknown as QdrantPayload, score: r.score }));
  }
}
