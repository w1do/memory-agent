import { describe, expect, it } from 'vitest';
import { redact } from '../../src/security/redact.js';
import { ExcludeMatcher, DEFAULT_EXCLUDES, hasForbiddenExtension } from '../../src/security/policy.js';
import { resolveInside } from '../../src/project/paths.js';
import { chunkFile } from '../../src/indexing/chunker.js';

describe('redact', () => {
  it('masks keys and quoted secrets', () => {
    expect(redact('const k = "sk-FAKEFAKEFAKEFAKEFAKE1234"')).not.toContain('FAKEFAKE');
    expect(redact('password: "hunter2-secret"')).not.toContain('hunter2');
  });
  it('keeps type annotations intact', () => {
    expect(redact('hash(password: string): string')).toBe('hash(password: string): string');
  });
});

describe('exclude policy', () => {
  const m = new ExcludeMatcher(DEFAULT_EXCLUDES);
  it.each(['.env', '.env.local', 'node_modules/a/b.js', 'certs/server.pem', 'id_rsa', 'app.sqlite', '.git/config'])('excludes %s', (p) => {
    expect(m.matches(p) || hasForbiddenExtension(p)).toBe(true);
  });
  it('keeps source files', () => expect(m.matches('src/auth/AuthService.ts')).toBe(false));
});

describe('path traversal', () => {
  it('rejects paths outside root', () => {
    expect(() => resolveInside('/tmp/proj', '../etc/passwd')).toThrow();
    expect(() => resolveInside('/tmp/proj', '/etc/passwd')).toThrow();
  });
  it('accepts inner paths', () => expect(resolveInside('/tmp/proj', 'src/a.ts').rel).toBe('src/a.ts'));
});

describe('chunker', () => {
  it('splits typescript into symbol chunks', () => {
    const chunks = chunkFile('typescript', 'export function a() {\n  return 1;\n}\n\nexport class B {\n  m() {}\n}\n', false);
    expect(chunks.map((c) => c.symbol)).toEqual(expect.arrayContaining(['a', 'B']));
  });
  it('falls back to line ranges for unknown languages', () => {
    expect(chunkFile('unknown', 'x\ny\n', false).length).toBeGreaterThan(0);
  });
});
