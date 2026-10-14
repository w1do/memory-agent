import { posix } from 'node:path';
import type { FileRecord, Relation } from '../shared/types.js';

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue', '.svelte', '.astro', '.php', '.py', '.go', '.rs', '.java', '.css', '.scss', '.md'];
const stripExt = (p: string) => p.replace(/\.[a-z0-9]+$/i, '');

export class PathIndex {
  private readonly all: Set<string>;
  private readonly bareToPaths = new Map<string, string[]>();

  constructor(paths: string[]) {
    this.all = new Set(paths);
    for (const p of paths) {
      const key = stripExt(p);
      this.bareToPaths.set(key, [...(this.bareToPaths.get(key) ?? []), p]);
    }
  }

  has = (p: string) => this.all.has(p);

  /** Resolves `base` (no extension needed) to an indexed path. */
  resolveBase(base: string): string | undefined {
    if (this.all.has(base)) return base;
    const jsStripped = base.replace(/\.(js|jsx|mjs)$/, '');
    for (const b of [base, jsStripped]) {
      for (const ext of EXTS) if (this.all.has(b + ext)) return b + ext;
      for (const ext of EXTS) if (this.all.has(`${b}/index${ext}`)) return `${b}/index${ext}`;
      if (this.all.has(`${b}/__init__.py`)) return `${b}/__init__.py`;
    }
    return undefined;
  }

  /** Suffix match for namespace-style imports (Java, PHP, Go, Rust, Python). */
  resolveSuffix(path: string): string | undefined {
    if (!path) return undefined;
    for (const [key, paths] of this.bareToPaths) {
      if (key === path || key.endsWith(`/${path}`)) return paths[0];
    }
    return undefined;
  }
}

function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function resolveSpec(file: FileRecord, spec: string, index: PathIndex): Relation | undefined {
  const dir = posix.dirname(file.relativePath);
  const from = file.relativePath;
  if (spec.startsWith('.') && /^\.{1,2}\//.test(spec)) {
    const target = index.resolveBase(posix.normalize(posix.join(dir, spec)));
    return target ? { fromPath: from, toPath: target, kind: file.language === 'markdown' ? 'doc' : 'import' } : undefined;
  }
  if (file.language === 'markdown') {
    const target = index.resolveBase(posix.normalize(posix.join(dir, spec))) ?? index.resolveBase(posix.normalize(spec));
    return target ? { fromPath: from, toPath: target, kind: 'doc' } : undefined;
  }
  if (['typescript', 'javascript', 'vue', 'svelte', 'css', 'scss'].includes(file.language)) {
    const local = index.resolveBase(posix.normalize(spec));
    return local ? { fromPath: from, toPath: local, kind: 'import' } : { fromPath: from, toPath: `pkg:${packageName(spec)}`, kind: 'package' };
  }
  const leading = spec.match(/^\.+/)?.[0] ?? '';
  const normalized = spec.replace(/^\.+/, '').replace(/::|\\|\./g, '/');
  const rel = leading ? index.resolveBase(posix.normalize(posix.join(dir, normalized))) : undefined;
  const target = rel ?? index.resolveSuffix(normalized) ?? index.resolveBase(normalized);
  return target && target !== from ? { fromPath: from, toPath: target, kind: 'import' } : undefined;
}

const testStem = (p: string) => stripExt(posix.basename(p)).replace(/[._-]?(test|spec)$/i, '').replace(/^test_/, '').replace(/Test$/, '');

export function buildRelations(
  file: FileRecord, imports: string[], index: PathIndex, nonTestByStem: Map<string, string[]>,
): Relation[] {
  const out = new Map<string, Relation>();
  const add = (r?: Relation) => { if (r && r.toPath !== file.relativePath) out.set(`${r.toPath}|${r.kind}`, r); };

  if (posix.basename(file.relativePath) === 'package.json') {
    imports.forEach((dep) => add({ fromPath: file.relativePath, toPath: `pkg:${dep}`, kind: 'package' }));
  } else {
    imports.forEach((spec) => add(resolveSpec(file, spec, index)));
  }
  if (file.isTest) {
    const candidates = nonTestByStem.get(testStem(file.relativePath)) ?? [];
    const nearest = [...candidates].sort((a, b) => sharedPrefix(b, file.relativePath) - sharedPrefix(a, file.relativePath));
    nearest.slice(0, 2).forEach((t) => add({ fromPath: file.relativePath, toPath: t, kind: 'test' }));
  }
  return [...out.values()];
}

const sharedPrefix = (a: string, b: string) => {
  const x = a.split('/'); const y = b.split('/'); let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return i;
};

export function nonTestStems(files: FileRecord[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const f of files) {
    if (f.isTest || f.isDocumentation || f.isConfig) continue;
    const stem = stripExt(posix.basename(f.relativePath));
    m.set(stem, [...(m.get(stem) ?? []), f.relativePath]);
  }
  return m;
}

export const moduleOf = (path: string): string => {
  const dir = posix.dirname(path);
  return dir === '.' ? '.' : dir;
};
