import { join } from 'node:path';
import { Manifest } from '../storage/manifest.js';
import { TypesenseStore } from '../storage/typesense.js';
import { QdrantStore } from '../storage/qdrant.js';
import { loadConfig, memoryDir, readEnvFile, type MemoryConfig } from '../project/config.js';
import { createEmbeddingProvider } from '../embeddings/factory.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { loadMatcher } from '../project/scan.js';
import type { ExcludeMatcher } from '../security/policy.js';
import { Logger } from './logger.js';

export interface MemoryContext {
  root: string;
  config: MemoryConfig;
  manifest: Manifest;
  typesense: TypesenseStore;
  qdrant: QdrantStore;
  embeddings: EmbeddingProvider;
  matcher: ExcludeMatcher;
  logger: Logger;
  close(): void;
}

export function openContext(root: string, opts: { quiet?: boolean } = {}): MemoryContext {
  const config = loadConfig(root);
  const env = readEnvFile(root);
  const manifest = new Manifest(join(memoryDir(root), 'index.db'));
  manifest.ensureProject(config.projectId, config.projectName, root);
  const apiKey = env.TYPESENSE_API_KEY ?? '';
  return {
    root, config, manifest,
    typesense: new TypesenseStore({ host: config.host, port: config.typesensePort, apiKey, collection: config.collection }),
    qdrant: new QdrantStore(config.host, config.qdrantPort, config.collection),
    embeddings: createEmbeddingProvider(config, env),
    matcher: loadMatcher(root),
    logger: new Logger(join(memoryDir(root), 'logs', 'memory.log'), opts.quiet),
    close: () => manifest.close(),
  };
}
