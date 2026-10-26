import { resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import { findProjectRoot } from '../project/root.js';
import { configPath } from '../project/config.js';
import { openContext, type MemoryContext } from '../shared/context.js';
import { MemoryError } from '../shared/errors.js';
import { activeGeneration } from '../storage/generation.js';

export type ContextResolver = ((project?: string) => MemoryContext) & { root?: (project?: string) => string };

/**
 * One MCP process for many projects: the project is the explicit argument, otherwise the one
 * containing the process working directory. Contexts are opened lazily and cached by root.
 */
export function createResolver(defaultDir?: string): { resolve: ContextResolver; closeAll(): void } {
  const open = new Map<string, MemoryContext>();
  // A previous async request may still be using its manifest after a new request repins.
  const retired = new Set<MemoryContext>();
  const rootOf = (project?: string) => findProjectRoot(resolvePath(project ?? defaultDir ?? process.cwd()));
  const resolve: ContextResolver = (project) => {
    const root = rootOf(project);
    const cached = open.get(root);
    if (cached && cached.manifest.generationId === activeGeneration(root)?.id) return cached;
    if (cached) { retired.add(cached); open.delete(root); }
    if (!existsSync(configPath(root))) {
      throw new MemoryError(`Project memory is not initialized in ${root}: run "memory init" there first`, 'not_initialized');
    }
    const ctx = openContext(root, { quiet: true });
    open.set(root, ctx);
    return ctx;
  };
  resolve.root = rootOf;
  const closeAll = (): void => {
    for (const c of [...open.values(), ...retired]) c.close();
    open.clear(); retired.clear();
  };
  return { resolve, closeAll };
}
