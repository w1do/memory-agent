const escape = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/**
 * Converts a gitignore-like pattern to a RegExp over POSIX relative paths.
 * Supports `*`, `**`, `?`, trailing `/` (directory) and leading `/` (anchored).
 * Patterns without a slash match at any depth.
 */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim();
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
  p = p.replace(/^\//, '');

  let body = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      body += '.*';
      i += p[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') body += '[^/]*';
    else if (c === '?') body += '[^/]';
    else body += escape(c);
  }
  const prefix = anchored ? '^' : '(?:^|/)';
  const suffix = dirOnly ? '/' : '(?:/|$)';
  return new RegExp(`${prefix}${body}${suffix}`);
}
