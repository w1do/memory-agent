import { rootFrom, withContext } from '../common.js';
import { dumpMemory } from '../../transfer/dump.js';
import { importMemory } from '../../transfer/import.js';
import { existsSync } from 'node:fs';
import { configPath, createDefaultConfig, loadConfig, readEnvFile } from '../../project/config.js';
import { isLegacyProject, mergeEnv } from '../../global/shared-mode.js';
import { registerProject } from '../../global/registry.js';

export async function importCommand(name: string, opts: { path?: string }): Promise<void> {
  const root = rootFrom(opts.path);
  const env = isLegacyProject(root) ? readEnvFile(root) : mergeEnv(readEnvFile(root));
  const config = existsSync(configPath(root)) ? loadConfig(root) : await createDefaultConfig(root, {
    qdrant: Number(env.QDRANT_PORT || 6333), typesense: Number(env.TYPESENSE_PORT || 8108),
  });
  const result = await importMemory(root, name, config, { env });
  registerProject(root);
  console.log(result.status === 'already-applied' ? `Dump ${name}: import already applied` : `Dump ${name}: imported ${result.generation.dumpId}`);
}

export async function dumpCommand(name: string, opts: { path?: string }): Promise<void> {
  await withContext(opts.path, async (ctx) => {
    const manifest = await dumpMemory(ctx, name);
    console.log(`Dump ${name}: ${manifest.dumpId}`);
  }, { exportAnnotationsOnClose: false });
}
