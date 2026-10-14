import { globToRegExp } from '../project/glob.js';

/**
 * Always excluded, independent of `.memoryignore`, so projects initialised by older
 * versions (whose ignore file lacks these entries) do not index tool or build output.
 */
export const DEFAULT_EXCLUDES = [
  '.git/', '.memory/', '.memoryignore',
  'node_modules/', 'vendor/', 'dist/', 'build/', '.next/', '.nuxt/', '.astro/', '.svelte-kit/',
  '.cache/', 'coverage/', 'tmp/', 'logs/',
  '.claude/', '.codex/', '.junie/', '.cursor/', '.opencode/', '.idea/', '.vscode/',
  '.env', '.env.*', '*.pem', '*.key', '*.crt', '*.p12', '*.pfx', 'id_rsa*',
  '*.sqlite', '*.db',
  '*.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.sum', 'composer.lock',
  '*.min.js', '*.min.css', '*.map',
];

/** Extensions never read, regardless of ignore files. */
export const FORBIDDEN_EXTENSIONS = new Set([
  '.pem', '.key', '.crt', '.p12', '.pfx', '.sqlite', '.db', '.keystore', '.jks',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf', '.zip', '.gz', '.tgz',
  '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.exe', '.dll', '.so', '.wasm',
]);

export const MAX_FILE_SIZE = 512 * 1024;

export class ExcludeMatcher {
  private readonly rules: RegExp[];

  constructor(patterns: string[]) {
    this.rules = patterns.map(globToRegExp);
  }

  matches(relativePath: string): boolean {
    const p = relativePath.replace(/\\/g, '/');
    return this.rules.some((re) => re.test(p));
  }
}

export function hasForbiddenExtension(relativePath: string): boolean {
  const dot = relativePath.lastIndexOf('.');
  return dot >= 0 && FORBIDDEN_EXTENSIONS.has(relativePath.slice(dot).toLowerCase());
}
