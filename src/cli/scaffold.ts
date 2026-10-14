import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDefaultConfig, ensureEnvFile, configPath, loadConfig, memoryDir, saveConfig, type MemoryConfig } from '../project/config.js';
import { renderCompose } from './compose.js';

/** Idempotent: existing config, .env, data and ignore rules are preserved. */
export async function scaffold(root: string): Promise<MemoryConfig> {
  const dir = memoryDir(root);
  for (const sub of ['data/qdrant', 'data/typesense', 'logs', 'generated']) mkdirSync(join(dir, sub), { recursive: true });
  const config = existsSync(configPath(root)) ? loadConfig(root) : await createDefaultConfig(root);
  saveConfig(config);
  ensureEnvFile(root);
  const user = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid?.()}` : undefined;
  writeFileSync(join(dir, 'docker-compose.yml'), renderCompose(config, user));
  writeFileSync(join(dir, '.gitignore'), '*\n!.gitignore\n!mcp.example.json\n');
  writeFileSync(join(dir, 'mcp.example.json'), JSON.stringify(mcpExample(root), null, 2) + '\n');
  ensureRootGitignore(root);
  return config;
}

export const mcpExample = (root: string) => ({
  mcpServers: { 'project-memory': { command: 'memory', args: ['mcp', '--project', root] } },
});

function ensureRootGitignore(root: string): void {
  const file = join(root, '.gitignore');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.split(/\r?\n/).some((l) => ['.memory', '.memory/', '/.memory', '/.memory/'].includes(l.trim()))) return;
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  appendFileSync(file, `${prefix}.memory/\n`);
}
