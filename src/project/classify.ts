import { basename, extname } from 'node:path';

const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript', '.php': 'php', '.py': 'python', '.go': 'go',
  '.rs': 'rust', '.java': 'java', '.vue': 'vue', '.svelte': 'svelte', '.css': 'css',
  '.scss': 'scss', '.astro': 'astro', '.md': 'markdown', '.mdx': 'markdown', '.json': 'json', '.yaml': 'yaml',
  '.yml': 'yaml', '.toml': 'toml', '.sql': 'sql', '.sh': 'shell',
};

const SPECIAL_NAMES = /^(readme(\..*)?|dockerfile(\..*)?|docker-compose.*\.ya?ml|makefile|.*\.lock|package-lock\.json|\.memoryignore)$/i;

export function detectLanguage(relativePath: string): string | null {
  const name = basename(relativePath);
  const ext = extname(name).toLowerCase();
  if (LANGUAGES[ext]) return LANGUAGES[ext];
  if (/^dockerfile/i.test(name)) return 'docker';
  if (/^readme/i.test(name)) return 'markdown';
  if (SPECIAL_NAMES.test(name)) return 'text';
  return null;
}

export const isTestFile = (p: string): boolean =>
  /(^|\/)(tests?|__tests__|spec)\//i.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p) ||
  /(^|\/)test_[^/]+\.py$|_test\.(go|py)$|Test\.(java|php)$/.test(p);

export const isDocumentation = (p: string, language: string): boolean =>
  language === 'markdown' || /(^|\/)docs?\//i.test(p);

export const isConfig = (p: string, language: string): boolean =>
  ['json', 'yaml', 'toml', 'docker'].includes(language) ||
  /\.lock$/.test(p) || /(^|\/)\.github\//.test(p) || /(^|\/)migrations?\//i.test(p);
