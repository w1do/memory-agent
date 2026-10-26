import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDefaultConfig, configPath, loadConfig, memoryDir, saveConfig, type MemoryConfig } from '../project/config.js';
import { registerProject } from '../global/registry.js';
import { sharedPorts } from '../global/shared-mode.js';
import { indexDbPath } from '../global/paths.js';
import { Manifest } from '../storage/manifest.js';
import { isActive, readJob } from '../indexing/job-state.js';

/** Idempotent: existing config, .env, data and ignore rules are preserved. */
export async function scaffold(root: string): Promise<MemoryConfig> {
  const proposed = existsSync(configPath(root)) ? loadConfig(root) : await createDefaultConfig(root, sharedPorts());
  const manifest = new Manifest(indexDbPath(proposed.projectId));
  try {
    // Serialise initial creation as well as repeat writes with acquireJob.
    return manifest.tx(() => {
      const configExists = existsSync(configPath(root));
      const config = configExists ? loadConfig(root) : proposed;
      const active = manifest.getMeta('active_index_job');
      if (active && isActive(readJob(manifest, active))) return config;
      return writeScaffold(root, config, configExists);
    }, true);
  } finally { manifest.close(); }
}

function writeScaffold(root: string, config: MemoryConfig, configExists: boolean): MemoryConfig {
  const dir = memoryDir(root);
  for (const sub of ['logs', 'generated']) mkdirSync(join(dir, sub), { recursive: true });
  if (!configExists) saveConfig(config);
  writeFileSync(join(dir, '.gitignore'), '*\n!.gitignore\n!mcp.example.json\n!annotations.json\n');
  writeFileSync(join(dir, 'mcp.example.json'), JSON.stringify(mcpExample(root), null, 2) + '\n');
  ensureRootGitignore(root);
  ensureMemoryIgnore(root);
  registerProject(root);
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

/** Idempotent: drops a whole-directory `.memory/` rule (it would hide annotations.json) and keeps only the annotations exception. */
export function ensureRootGitignore(root: string): void {
  const file = join(root, '.gitignore');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const managed = ['.memory', '.memory/', '/.memory', '/.memory/', '.memory/*', '/.memory/*', '!.memory/annotations.json'];
  const lines = current.split(/\r?\n/).filter((l) => !managed.includes(l.trim()));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const next = [...lines, '.memory/*', '!.memory/annotations.json'].join('\n') + '\n';
  if (next !== current) writeFileSync(file, next);
}
