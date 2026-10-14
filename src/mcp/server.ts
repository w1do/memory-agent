import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { MemoryContext } from '../shared/context.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';

export function createMcpServer(ctx: MemoryContext): McpServer {
  const server = new McpServer({ name: 'project-memory', version: '0.1.0' });
  registerTools(server, ctx);
  registerResources(server, ctx);
  return server;
}

/** Runs the MCP server over stdio. stdout carries protocol frames only; logs go to stderr/file. */
export async function runStdio(ctx: MemoryContext): Promise<void> {
  await createMcpServer(ctx).connect(new StdioServerTransport());
}
