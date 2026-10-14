import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installAgent, parseAgents } from '../../src/cli/agents.js';

describe('mcp install agents', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'agents-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('writes project-memory into every agent config and keeps foreign servers', () => {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    for (const agent of ['claude', 'junie', 'codex', 'opencode'] as const) installAgent(agent, { kind: 'project', root });

    const claude = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(claude.mcpServers.other).toEqual({ command: 'x' });
    expect(claude.mcpServers['project-memory'].args).toEqual(['mcp', '--project', root]);
    expect(JSON.parse(readFileSync(join(root, '.junie/mcp/mcp.json'), 'utf8')).mcpServers['project-memory'].command).toBe('memory');
    expect(JSON.parse(readFileSync(join(root, 'opencode.json'), 'utf8')).mcp['project-memory'].type).toBe('local');
    expect(readFileSync(join(root, '.codex/config.toml'), 'utf8')).toContain('[mcp_servers.project-memory]');
  });

  it('is idempotent for codex managed block', () => {
    installAgent('codex', { kind: 'project', root });
    installAgent('codex', { kind: 'project', root });
    const toml = readFileSync(join(root, '.codex/config.toml'), 'utf8');
    expect(toml.match(/BEGIN project-memory/g)).toHaveLength(1);
    expect(toml.match(/\[mcp_servers\.project-memory\]/g)).toHaveLength(1);
  });

  it('refuses to overwrite a manually defined codex server', () => {
    const file = join(root, '.codex/config.toml');
    mkdirSync(join(root, '.codex'));
    writeFileSync(file, '[mcp_servers.project-memory]\ncommand = "memory"\n');
    expect(() => installAgent('codex', { kind: 'project', root })).toThrow(/defined manually/);
    expect(existsSync(file)).toBe(true);
  });

  it('writes user-level configs for global scope without project path', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    try {
      for (const agent of ['claude', 'junie', 'codex', 'opencode'] as const) installAgent(agent, { kind: 'global', home });
      const claude = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
      expect(claude.mcpServers['project-memory'].args).toEqual(['mcp']);
      expect(JSON.parse(readFileSync(join(home, '.config/opencode/opencode.json'), 'utf8')).mcp['project-memory'].command).toEqual(['memory', 'mcp']);
      expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toContain('args = ["mcp"]');
      expect(existsSync(join(root, '.mcp.json'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('parses agent lists and rejects unknown agents', () => {
    expect(parseAgents('Claude, junie,claude')).toEqual(['claude', 'junie']);
    expect(() => parseAgents('foo')).toThrow(/Unknown agent/);
  });
});
