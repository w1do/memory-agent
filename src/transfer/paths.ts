import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { DEFAULT_EXCLUDES, ExcludeMatcher, hasForbiddenExtension } from '../security/policy.js';

const excluded = new ExcludeMatcher([...DEFAULT_EXCLUDES, 'global.env', '.env*', '*credentials*',
  'id_ed25519*', '*.log', 'docker-compose*.yml', 'docker-compose*.yaml', 'volumes/', 'data/']);

export function assertPortablePath(path: string): void {
  if (!path || isAbsolute(path) || /[\\\0:]/.test(path) || path.split('/').some((p) => !p || p === '.' || p === '..')) {
    throw new Error(`Unsafe relative path: ${path}`);
  }
}

export function assertAllowedPath(path: string): void {
  assertPortablePath(path);
  if (excluded.matches(path) || hasForbiddenExtension(path)) {
    throw new Error(`Forbidden indexed path: ${path}; clean the index before transfer`);
  }
}

/** Reject every symlink component, including links pointing back inside the project. */
export function assertNoSymlink(root: string, relative: string): void {
  assertPortablePath(relative);
  let path = realpathSync(root);
  for (const part of relative.split('/')) {
    path = join(path, part);
    try { if (lstatSync(path).isSymbolicLink()) throw new Error(`Symlink is forbidden: ${relative}`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}

export function dumpPath(root: string, name: string, create = false): string {
  if (!name || name.includes('..') || /[\/\\\0:]/.test(name) || name === '.') throw new Error('Dump name must be one safe path component');
  assertNoSymlink(root, `memory/${name}`);
  const dir = join(root, 'memory');
  if (create && !existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  return join(dir, name);
}
