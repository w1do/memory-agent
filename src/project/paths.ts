import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { PathOutsideProjectError } from '../shared/errors.js';

export const toPosix = (p: string): string => p.split(sep).join('/');

/**
 * Resolves a user-supplied path against the project root and guarantees it
 * stays inside it (lexically and, if it exists, after resolving symlinks).
 */
export function resolveInside(root: string, input: string): { abs: string; rel: string } {
  const abs = resolve(root, input);
  assertInside(root, abs, input);
  try {
    assertInside(realpathSync(root), realpathSync(abs), input);
  } catch (e) {
    if (e instanceof PathOutsideProjectError) throw e;
  }
  const rel = toPosix(relative(root, abs));
  return { abs, rel };
}

function assertInside(root: string, abs: string, original: string): void {
  const rel = relative(root, abs);
  if (rel === '' ) return;
  if (rel.startsWith('..') || isAbsolute(rel)) throw new PathOutsideProjectError(original);
}
