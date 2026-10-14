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
  ensureMemoryIgnore(root);
  return config;
}

export const mcpExample = (root: string) => ({
  mcpServers: { 'project-memory': { command: 'memory', args: ['mcp', '--project', root] } },
});

export const DEFAULT_MEMORYIGNORE = `# Files and folders that must not enter the memory index (gitignore-like syntax).
# Created by "memory init"; never overwritten. Edit freely.

# Dependencies
node_modules/
bower_components/
jspm_packages/
vendor/
Pods/
Carthage/
.venv/
venv/
site-packages/
__pypackages__/
.gradle/
.m2/
.bundle/
.pnpm-store/
.yarn/
.npm/
.cargo/
.pub-cache/
.dart_tool/

# Lock files
*.lock
*.lockb
package-lock.json
npm-shrinkwrap.json
pnpm-lock.yaml
composer.lock
poetry.lock
Pipfile.lock
go.sum
go.work.sum

# Build output and caches
dist/
build/
out/
target/
.next/
.nuxt/
.output/
.svelte-kit/
.turbo/
.parcel-cache/
.cache/
.angular/
__pycache__/
*.pyc
.pytest_cache/
.mypy_cache/
.ruff_cache/
.tox/
*.egg-info/
coverage/
.nyc_output/
tmp/
temp/

# Minified, generated, data-like files
*.min.js
*.min.css
*.bundle.js
*.chunk.js
*.map
*.log
*.tsbuildinfo
*.snap
*.svg
*.csv
*.tsv
*.ndjson
*.wasm
*.pb.go
*_pb2.py

# Framework, AI-agent and IDE tool folders
.astro/
.svelte-kit/
.claude/
.codex/
.junie/
.cursor/
.opencode/
.idea/
.vscode/

# IDE and OS
.DS_Store
Thumbs.db

# Test fixtures and snapshots
**/fixtures/
**/__snapshots__/
`;

/** Never overwrites an existing user-edited .memoryignore. */
function ensureMemoryIgnore(root: string): void {
  const file = join(root, '.memoryignore');
  if (!existsSync(file)) writeFileSync(file, DEFAULT_MEMORYIGNORE);
}

function ensureRootGitignore(root: string): void {
  const file = join(root, '.gitignore');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.split(/\r?\n/).some((l) => ['.memory', '.memory/', '/.memory', '/.memory/'].includes(l.trim()))) return;
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  appendFileSync(file, `${prefix}.memory/\n`);
}
