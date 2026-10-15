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
import { resolveIndexDb } from '../global/index-location.js';
import { exportAnnotations, importAnnotations } from '../global/annotations-file.js';
import { isLegacyProject, mergeEnv, sharedPorts } from '../global/shared-mode.js';

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
  const legacy = isLegacyProject(root);
  const env = legacy ? readEnvFile(root) : mergeEnv(readEnvFile(root));
  const ports = legacy ? { qdrant: config.qdrantPort, typesense: config.typesensePort } : sharedPorts();
  const manifest = new Manifest(resolveIndexDb(root, config.projectId));
  manifest.ensureProject(config.projectId, config.projectName, root);
  importAnnotations(root, manifest);
  const apiKey = env.TYPESENSE_API_KEY ?? '';
  return {
    root, config, manifest,
    typesense: new TypesenseStore({ host: config.host, port: ports.typesense, apiKey, collection: config.collection }),
    qdrant: new QdrantStore(config.host, ports.qdrant, config.collection),
    embeddings: createEmbeddingProvider(config, env),
    matcher: loadMatcher(root),
    logger: new Logger(join(memoryDir(root), 'logs', 'memory.log'), opts.quiet),
    close: () => { exportAnnotations(root, manifest); manifest.close(); },
  };
}
