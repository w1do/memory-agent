import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createResolver, type ContextResolver } from './projects.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';

export function createMcpServer(resolve: ContextResolver): McpServer {
  const server = new McpServer({ name: 'project-memory', version: '0.1.0' });
  registerTools(server, resolve);
  registerResources(server, resolve);
  return server;
}

/** Runs one MCP server over stdio for any project. stdout carries protocol frames only. */
export async function runStdio(defaultDir?: string): Promise<void> {
  const { resolve, closeAll } = createResolver(defaultDir);
  const stop = (): void => { closeAll(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdin.once('end', stop);
  process.once('exit', closeAll);
  await createMcpServer(resolve).connect(new StdioServerTransport());
}
