import { QdrantStore } from '../storage/qdrant.js';
import { TypesenseStore } from '../storage/typesense.js';
import type { EnvMap, MemoryConfig } from '../project/config.js';

export interface ImportStores {
  qdrant: Pick<QdrantStore, 'createFromSnapshot' | 'upsert' | 'dropCollection' | 'count' | 'exportSnapshot'>;
  typesense: Pick<TypesenseStore, 'createFromSnapshot' | 'upsert' | 'dropCollection' | 'count' | 'exportSnapshot'>;
}
export type StoreFactory = (collection: string) => ImportStores;

export function importStores(config: MemoryConfig, env: EnvMap): StoreFactory {
  return (collection) => ({
    qdrant: new QdrantStore(config.host, Number(env.QDRANT_PORT || config.qdrantPort), collection),
    typesense: new TypesenseStore({ host: config.host, port: Number(env.TYPESENSE_PORT || config.typesensePort),
      apiKey: env.TYPESENSE_API_KEY ?? '', collection }),
  });
}
