import { execFileSync } from 'node:child_process';

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    }).trim();
  } catch {
    return '';
  }
}

export const gitRoot = (cwd: string): string => git(cwd, ['rev-parse', '--show-toplevel']);
export const gitBranch = (cwd: string): string => git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
export const gitCommit = (cwd: string): string => git(cwd, ['rev-parse', '--short', 'HEAD']);

/** Paths (POSIX, relative to root) with uncommitted changes. Empty outside Git. */
export function gitDirtyPaths(cwd: string): Set<string> {
  const out = git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  const result = new Set<string>();
  for (const entry of out.split('\0')) {
    if (entry.length > 3) result.add(entry.slice(3));
  }
  return result;
}
