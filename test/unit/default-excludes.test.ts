import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDES, ExcludeMatcher } from '../../src/security/policy.js';
import { isIndexable } from '../../src/project/scan.js';

const matcher = new ExcludeMatcher(DEFAULT_EXCLUDES);
const indexable = (path: string) => isIndexable(matcher, path, 100, 512 * 1024) !== null;

describe('built-in excludes apply even without a fresh .memoryignore', () => {
  it.each([
    '.astro/collections/blog.schema.json',
    '.claude/commands/opsx/apply.md',
    '.codex/config.toml',
    '.junie/commands/pages.md',
    '.junie/mcp/mcp.json',
    '.memoryignore',
    'package-lock.json',
    'frontend/yarn.lock',
    'public/app.min.js',
  ])('excludes %s', (path) => {
    expect(indexable(path)).toBe(false);
  });

  it.each(['src/auth/AuthService.ts', 'README.md', 'package.json'])('keeps %s', (path) => {
    expect(indexable(path)).toBe(true);
  });
});
