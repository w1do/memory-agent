import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpInstallCommand } from '../../src/cli/commands/mcp-install.js';
import { mcpCommand } from '../../src/cli/commands/search.js';
import { MemoryError } from '../../src/shared/errors.js';

describe('memory mcp install command', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-install-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('writes config only for the selected agents', async () => {
    await mcpInstallCommand({ path: root, agents: 'claude,opencode' });

    const claude = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(claude.mcpServers['project-memory']).toEqual({ type: 'stdio', command: 'memory', args: ['mcp', '--project', root] });
    const opencode = JSON.parse(readFileSync(join(root, 'opencode.json'), 'utf8'));
    expect(opencode.mcp['project-memory'].command).toEqual(['memory', 'mcp', '--project', root]);
    expect(existsSync(join(root, '.junie'))).toBe(false);
    expect(existsSync(join(root, '.codex'))).toBe(false);
  });

  it('writes every agent when all are listed', async () => {
    await mcpInstallCommand({ path: root, agents: 'claude,junie,codex,opencode' });

    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
    expect(readFileSync(join(root, '.junie/mcp/mcp.json'), 'utf8')).toContain('project-memory');
    expect(readFileSync(join(root, '.codex/config.toml'), 'utf8')).toContain('[mcp_servers.project-memory]');
    expect(existsSync(join(root, 'opencode.json'))).toBe(true);
  });

  it('is idempotent and keeps foreign MCP servers', async () => {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    await mcpInstallCommand({ path: root, agents: 'claude' });
    await mcpInstallCommand({ path: root, agents: 'claude' });

    const claude = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(Object.keys(claude.mcpServers).sort()).toEqual(['other', 'project-memory']);
    expect(claude.mcpServers.other).toEqual({ command: 'x' });
  });

  it('rejects unknown agent names without writing files', async () => {
    const error = await mcpInstallCommand({ path: root, agents: 'claude,foo' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoryError);
    expect((error as MemoryError).code).toBe('unknown_agent');
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
  });

  it('rejects an empty agent list', async () => {
    const error = await mcpInstallCommand({ path: root, agents: ' , ' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoryError);
    expect((error as MemoryError).code).toBe('no_agents');
  });

  it('reports a manually defined codex server instead of overwriting it', async () => {
    mkdirSync(join(root, '.codex'));
    writeFileSync(join(root, '.codex/config.toml'), '[mcp_servers.project-memory]\ncommand = "memory"\n');

    await expect(mcpInstallCommand({ path: root, agents: 'codex' })).rejects.toThrow(/defined manually/);
    expect(readFileSync(join(root, '.codex/config.toml'), 'utf8')).toBe('[mcp_servers.project-memory]\ncommand = "memory"\n');
  });
});

describe('memory mcp command', () => {
  it('fails with a clear error when the project is not initialized', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-uninit-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      await expect(mcpCommand({ project: dir })).rejects.toThrow(/not initialized/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('memory mcp install --global', () => {
  it('writes user-level configs into the given home directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-install-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await mcpInstallCommand({ global: true, home, agents: 'claude,codex' });
      expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers['project-memory'].args).toEqual(['mcp']);
      expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toContain('[mcp_servers.project-memory]');
    } finally {
      vi.restoreAllMocks();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
