import { resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import { findProjectRoot } from '../project/root.js';
import { configPath } from '../project/config.js';
import { openContext, type MemoryContext } from '../shared/context.js';
import { MemoryError } from '../shared/errors.js';

export type ContextResolver = ((project?: string) => MemoryContext) & { root?: (project?: string) => string };

/**
 * One MCP process for many projects: the project is the explicit argument, otherwise the one
 * containing the process working directory. Contexts are opened lazily and cached by root.
 */
export function createResolver(defaultDir?: string): { resolve: ContextResolver; closeAll(): void } {
  const open = new Map<string, MemoryContext>();
  const rootOf = (project?: string) => findProjectRoot(resolvePath(project ?? defaultDir ?? process.cwd()));
  const resolve: ContextResolver = (project) => {
    const root = rootOf(project);
    const cached = open.get(root);
    if (cached) return cached;
    if (!existsSync(configPath(root))) {
      throw new MemoryError(`Project memory is not initialized in ${root}: run "memory init" there first`, 'not_initialized');
    }
    const ctx = openContext(root, { quiet: true });
    open.set(root, ctx);
    return ctx;
  };
  resolve.root = rootOf;
  const closeAll = (): void => { for (const c of open.values()) c.close(); open.clear(); };
  return { resolve, closeAll };
}
