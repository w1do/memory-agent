import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_EXCLUDES, ExcludeMatcher, hasForbiddenExtension } from '../security/policy.js';
import { detectLanguage } from './classify.js';
import { toPosix } from './paths.js';

export interface ScannedFile {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
  language: string;
}

export function loadMatcher(root: string): ExcludeMatcher {
  const file = join(root, '.memoryignore');
  const extra = existsSync(file)
    ? readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : [];
  return new ExcludeMatcher([...DEFAULT_EXCLUDES, ...extra]);
}

/** Returns true if a file may be indexed at all (name, extension, size). */
export function isIndexable(
  matcher: ExcludeMatcher, relativePath: string, size: number, maxSize: number,
): string | null {
  if (matcher.matches(relativePath) || hasForbiddenExtension(relativePath)) return null;
  if (size > maxSize) return null;
  return detectLanguage(relativePath);
}

/** Lists indexable files using only stat() — contents are never read here. */
export function scanProject(root: string, matcher: ExcludeMatcher, maxSize: number): ScannedFile[] {
  const result: ScannedFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = toPosix(abs.slice(root.length + 1));
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!matcher.matches(`${rel}/`)) walk(abs);
      } else if (entry.isFile()) {
        const st = statSync(abs);
        const language = isIndexable(matcher, rel, st.size, maxSize);
        if (language) {
          result.push({ relativePath: rel, absolutePath: abs, size: st.size, mtimeMs: Math.floor(st.mtimeMs), language });
        }
      }
    }
  };
  walk(root);
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
