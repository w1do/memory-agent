import type { ChunkType } from '../shared/types.js';

export interface DeclRule {
  re: RegExp; // group 1 = symbol name
  kind: ChunkType;
}

const jsLike: DeclRule[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?(?:type|enum)\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, kind: 'function' },
];

/** Declaration rules per language. Brace-based unless listed in INDENT_LANGUAGES. */
export const RULES: Record<string, DeclRule[]> = {
  typescript: jsLike,
  javascript: jsLike,
  vue: jsLike,
  svelte: jsLike,
  php: [
    { re: /^\s*(?:abstract\s+|final\s+)?(?:class|trait|enum)\s+(\w+)/, kind: 'class' },
    { re: /^\s*interface\s+(\w+)/, kind: 'interface' },
    { re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+&?(\w+)/, kind: 'function' },
  ],
  java: [
    { re: /^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|static\s+)*(?:class|enum|record)\s+(\w+)/, kind: 'class' },
    { re: /^\s*(?:public\s+|private\s+|protected\s+)*interface\s+(\w+)/, kind: 'interface' },
  ],
  go: [
    { re: /^func\s+\([^)]*\)\s*(\w+)/, kind: 'method' },
    { re: /^func\s+(\w+)/, kind: 'function' },
    { re: /^type\s+(\w+)\s+struct/, kind: 'class' },
    { re: /^type\s+(\w+)\s+interface/, kind: 'interface' },
  ],
  rust: [
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, kind: 'function' },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum)\s+(\w+)/, kind: 'class' },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/, kind: 'interface' },
    { re: /^\s*impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?(\w+)/, kind: 'class' },
  ],
  python: [
    { re: /^\s*class\s+(\w+)/, kind: 'class' },
    { re: /^\s*(?:async\s+)?def\s+(\w+)/, kind: 'function' },
  ],
};

export const INDENT_LANGUAGES = new Set(['python']);
export const EXPORT_RE: Record<string, RegExp> = {
  typescript: /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|function\*?|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/,
  javascript: /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:class|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/,
  go: /^(?:func|type|var|const)\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/,
  rust: /^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|mod|const|type)\s+(\w+)/,
  php: /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+(\w+)/,
  java: /^\s*public\s+(?:abstract\s+|final\s+|static\s+)*(?:class|interface|enum|record)\s+(\w+)/,
};
EXPORT_RE.vue = EXPORT_RE.javascript;
EXPORT_RE.svelte = EXPORT_RE.javascript;

export const IMPORT_RE: Record<string, RegExp[]> = {
  typescript: [
    /(?:^|\s)import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?\*?[^'"\n]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  python: [/^\s*from\s+([.\w]+)\s+import\b/gm, /^\s*import\s+([\w.]+)/gm],
  go: [/^\s*(?:import\s+)?(?:\w+\s+)?"([^"\n]+\/[^"\n]*)"\s*$/gm],
  rust: [/^\s*(?:pub\s+)?use\s+([\w:]+)/gm, /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm],
  php: [/^\s*use\s+([\w\\]+)(?:\s+as\s+\w+)?;/gm, /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g],
  java: [/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm],
  css: [/@import\s+(?:url\()?['"]([^'"]+)['"]/g],
};
IMPORT_RE.javascript = IMPORT_RE.typescript;
IMPORT_RE.vue = IMPORT_RE.typescript;
IMPORT_RE.svelte = IMPORT_RE.typescript;
IMPORT_RE.scss = IMPORT_RE.css;
