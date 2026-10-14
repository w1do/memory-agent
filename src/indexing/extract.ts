import { EXPORT_RE, IMPORT_RE } from './rules.js';

export function extractImports(language: string, content: string): string[] {
  const found = new Set<string>();
  for (const re of IMPORT_RE[language] ?? []) {
    for (const m of content.matchAll(new RegExp(re.source, re.flags))) found.add(m[1]);
  }
  return [...found];
}

export function extractExports(language: string, content: string): string[] {
  const re = EXPORT_RE[language];
  if (!re) return [];
  const found = new Set<string>();
  for (const line of content.split('\n')) {
    const m = re.exec(line);
    if (m) found.add(m[1]);
  }
  return [...found];
}

/** Relative file references from Markdown links: `[text](./path/to/file.ts)`. */
export function extractDocLinks(content: string): string[] {
  const found = new Set<string>();
  for (const m of content.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    if (!/^[a-z]+:/i.test(m[1])) found.add(m[1]);
  }
  for (const m of content.matchAll(/`([\w./-]+\.[a-z]{1,5})`/g)) found.add(m[1]);
  return [...found];
}

/** Dependency names declared in a package.json. */
export function extractPackageDeps(content: string): string[] {
  try {
    const pkg = JSON.parse(content) as Record<string, Record<string, string> | undefined>;
    return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .flatMap((k) => Object.keys(pkg[k] ?? {}));
  } catch {
    return [];
  }
}
