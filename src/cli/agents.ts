import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MemoryError } from '../shared/errors.js';

export const AGENTS = ['claude', 'junie', 'codex', 'opencode'] as const;
export type AgentId = (typeof AGENTS)[number];

export const SERVER_NAME = 'project-memory';
const BEGIN = `# BEGIN ${SERVER_NAME} (managed by memory mcp install)`;
const END = `# END ${SERVER_NAME}`;

type Json = Record<string, unknown>;

const readJson = (file: string): Json => {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Json;
  } catch {
    throw new MemoryError(`Cannot update ${file}: existing file is not a valid JSON object`, 'invalid_agent_config');
  }
};

const writeJson = (file: string, data: Json): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
};

const mergeJsonServer = (file: string, key: 'mcpServers' | 'mcp', entry: Json): void => {
  const data = readJson(file);
  const section = (data[key] && typeof data[key] === 'object' ? data[key] : {}) as Json;
  writeJson(file, { ...data, [key]: { ...section, [SERVER_NAME]: entry } });
};

const tomlBlock = (args: string[]): string => [
  BEGIN,
  `[mcp_servers.${SERVER_NAME}]`,
  'command = "memory"',
  `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
  END,
].join('\n');

const writeCodexToml = (file: string, args: string[]): void => {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${esc(BEGIN)}[\\s\\S]*?${esc(END)}\\n?`);
  const stripped = current.replace(pattern, '');
  if (stripped.includes(`[mcp_servers.${SERVER_NAME}]`)) {
    throw new MemoryError(`Cannot update ${file}: [mcp_servers.${SERVER_NAME}] is defined manually; remove it first`, 'invalid_agent_config');
  }
  const prefix = stripped && !stripped.endsWith('\n') ? '\n' : '';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${stripped}${prefix}${stripped ? '\n' : ''}${tomlBlock(args)}\n`);
};

/** Project scope writes into the repository; global scope writes user-level configs and relies on the agent's cwd. */
export type InstallScope = { kind: 'project'; root: string } | { kind: 'global'; home: string };

export function installAgent(agent: AgentId, scope: InstallScope): string {
  const command = 'memory';
  const base = scope.kind === 'project' ? scope.root : scope.home;
  const args = scope.kind === 'project' ? ['mcp', '--project', scope.root] : ['mcp'];
  switch (agent) {
    case 'claude': {
      const file = scope.kind === 'project' ? join(base, '.mcp.json') : join(base, '.claude.json');
      mergeJsonServer(file, 'mcpServers', { type: 'stdio', command, args });
      return file;
    }
    case 'junie': {
      const file = join(base, '.junie', 'mcp', 'mcp.json');
      mergeJsonServer(file, 'mcpServers', { command, args });
      return file;
    }
    case 'opencode': {
      const file = scope.kind === 'project' ? join(base, 'opencode.json') : join(base, '.config', 'opencode', 'opencode.json');
      mergeJsonServer(file, 'mcp', { type: 'local', command: [command, ...args], enabled: true });
      return file;
    }
    case 'codex': {
      const file = join(base, '.codex', 'config.toml');
      writeCodexToml(file, args);
      return file;
    }
  }
}

export const parseAgents = (raw: string): AgentId[] => {
  const ids = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = ids.filter((id) => !(AGENTS as readonly string[]).includes(id));
  if (unknown.length) throw new MemoryError(`Unknown agent(s): ${unknown.join(', ')}. Use: ${AGENTS.join(', ')}`, 'unknown_agent');
  return [...new Set(ids)] as AgentId[];
};
