import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContextResolver } from './projects.js';
import { projectStructure } from '../project/structure.js';
import { getStatus } from '../project/status.js';
import { readFileSlice } from '../project/read-file.js';
import { redact } from '../security/redact.js';

const text = (uri: string, body: string, mimeType = 'text/plain') => ({
  contents: [{ uri, mimeType, text: redact(body) }],
});

export function registerResources(server: McpServer, resolve: ContextResolver): void {
  server.registerResource('overview', 'memory://project/overview', { description: 'Project summary', mimeType: 'application/json' },
    async (uri) => {
      const ctx = resolve();
      const c = ctx.manifest.counts();
      return text(uri.href, JSON.stringify({
        project: ctx.config.projectName, collection: ctx.config.collection, ...c,
        last_sync_at: ctx.manifest.getMeta('last_sync_at') ?? null,
        recent_files: ctx.manifest.recentFiles(10).map((f) => f.relativePath),
      }, null, 1), 'application/json');
    });
  server.registerResource('structure', 'memory://project/structure', { description: 'Compact project tree' },
    async (uri) => text(uri.href, projectStructure(resolve())));
  server.registerResource('status', 'memory://project/status', { description: 'Index and service status', mimeType: 'application/json' },
    async (uri) => text(uri.href, JSON.stringify(await getStatus(resolve()), null, 1), 'application/json'));
  server.registerResource('file', new ResourceTemplate('memory://file/{+path}', { list: undefined }),
    { description: 'A single project file (first 200 lines)' },
    async (uri, vars) => {
      const path = decodeURIComponent(String(vars.path));
      return text(uri.href, readFileSlice(resolve(), path).content);
    });
}
