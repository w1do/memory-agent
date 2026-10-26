import type { QdrantPayload } from '../storage/qdrant.js';
import type { TsDoc } from '../storage/typesense.js';
import type { DumpManifestBody } from './manifest.js';
import type { LogicalIndex } from './sqlite.js';

export type JsonObject = DumpManifestBody['collections']['qdrant'];
export interface TransferPoint { id: string; vector: number[]; payload: QdrantPayload }
export interface VectorSnapshot { version: string; parameters: JsonObject; points: TransferPoint[] }
export interface LexicalSnapshot { version: string; schema: JsonObject; documents: TsDoc[] }
export interface Snapshot { index: LogicalIndex; vectors: VectorSnapshot; lexical: LexicalSnapshot }
