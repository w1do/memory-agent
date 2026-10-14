import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { relative } from 'node:path';
import { rootFrom } from '../common.js';
import { AGENTS, installAgent, parseAgents, type AgentId, type InstallScope } from '../agents.js';
import { MemoryError } from '../../shared/errors.js';

const LABELS: Record<AgentId, string> = {
  claude: 'Claude Code (.mcp.json)',
  junie: 'Junie (.junie/mcp/mcp.json)',
  codex: 'Codex (.codex/config.toml)',
  opencode: 'OpenCode (opencode.json)',
};

async function chooseInteractively(): Promise<AgentId[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Выберите агентов для установки project-memory:');
    AGENTS.forEach((id, i) => console.log(`  [x] ${i + 1}. ${LABELS[id]}`));
    const answer = (await rl.question('Номера через запятую (Enter — все): ')).trim();
    if (!answer) return [...AGENTS];
    const picked = answer.split(',').map((s) => Number(s.trim()));
    if (picked.some((n) => !Number.isInteger(n) || n < 1 || n > AGENTS.length)) {
      throw new MemoryError(`Invalid selection: ${answer}`, 'invalid_selection');
    }
    return [...new Set(picked.map((n) => AGENTS[n - 1]))];
  } finally {
    rl.close();
  }
}

export interface McpInstallOptions { path?: string; agents?: string; global?: boolean; home?: string }

export async function mcpInstallCommand(o: McpInstallOptions): Promise<void> {
  const scope: InstallScope = o.global
    ? { kind: 'global', home: o.home ?? homedir() }
    : { kind: 'project', root: rootFrom(o.path) };
  const agents = o.agents !== undefined
    ? parseAgents(o.agents)
    : process.stdin.isTTY ? await chooseInteractively() : [...AGENTS];
  if (agents.length === 0) throw new MemoryError('No agents selected', 'no_agents');
  for (const agent of agents) {
    const file = installAgent(agent, scope);
    const shown = scope.kind === 'project' ? relative(scope.root, file) || file : file;
    console.log(`✔ ${LABELS[agent]} → ${shown}`);
  }
  console.log('Перезапустите агентов, чтобы они подхватили MCP-сервер project-memory.');
}
