import { resolve } from 'node:path';
import { gitRoot } from './git.js';

/** Git root if the directory is inside a repository, otherwise the directory itself. */
export function findProjectRoot(start: string): string {
  const abs = resolve(start);
  return gitRoot(abs) ? resolve(gitRoot(abs)) : abs;
}
