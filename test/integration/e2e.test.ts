import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = resolve('dist/cli/index.js');
const run = (cwd: string, ...args: string[]) =>
  execFileSync('node', [cli, ...args], { cwd, encoding: 'utf8', timeout: 600_000 });

let dir: string;
let client: Client;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: !!r.isError, text: r.content[0].text, json: () => JSON.parse(r.content[0].text) };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pm-e2e-'));
  cpSync('test/fixtures/sample-project', dir, { recursive: true });
  writeFileSync(join(dir, '.env'), 'API_TOKEN=abcdef123456789\n');
  run(dir, 'init', '--yes');
  client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: 'node', args: [cli, 'mcp', '--project', dir] }));
}, 600_000);

afterAll(async () => {
  await client?.close();
  try { run(dir, 'stop'); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* container-owned files */ }
});

describe('memory e2e', () => {
  it('repeated init does not reindex unchanged files', () => {
    expect(run(dir, 'init', '--yes')).toMatch(/added 0, changed 0, renamed 0, removed 0/);
  });
  it('lists the MCP tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['memory_search', 'memory_get_context', 'memory_get_file', 'memory_related', 'memory_update', 'memory_sync', 'memory_status', 'memory_project_structure']));
  });
  it('finds by exact path and symbol', async () => {
    const byPath = (await call('memory_search', { query: 'src/auth/AuthService.ts', mode: 'lexical' })).json();
    expect(byPath.hits[0].path).toBe('src/auth/AuthService.ts');
    const bySymbol = (await call('memory_search', { query: 'hashPassword', mode: 'lexical' })).json();
    expect(bySymbol.hits[0].symbol).toBe('hashPassword');
  });
  it('reports related files', async () => {
    const r = (await call('memory_related', { path: 'src/auth/AuthService.ts' })).json();
    expect(JSON.stringify(r)).toContain('AuthController.ts');
    expect(JSON.stringify(r)).toContain('UserRepository.ts');
  });
  it('respects the char budget', async () => {
    const r = await call('memory_search', { query: 'auth', mode: 'lexical', max_chars: 1500 });
    expect(r.text.length).toBeLessThan(3500);
  });
  it('never indexes or returns secrets', async () => {
    const all = (await call('memory_search', { query: 'hunter2 FAKEFAKE abcdef123456789', mode: 'lexical' })).text;
    expect(all).not.toMatch(/hunter2|FAKEFAKEFAKE|abcdef123456789/);
    expect((await call('memory_get_file', { path: '.env' })).isError).toBe(true);
  });
  it('blocks path traversal', async () => {
    expect((await call('memory_get_file', { path: '../../etc/passwd' })).isError).toBe(true);
    expect((await call('memory_update', { paths: ['../x.ts'] })).isError).toBe(true);
  });
  it('updates a changed file via memory_update', async () => {
    writeFileSync(join(dir, 'src/changeable.ts'), "export function version(): string {\n  return 'v2-zebra';\n}\n");
    expect((await call('memory_update', { paths: ['src/changeable.ts'] })).isError).toBe(false);
    const r = (await call('memory_search', { query: 'zebra', mode: 'lexical' })).json();
    expect(r.hits[0].path).toBe('src/changeable.ts');
  });
  it('removes a deleted file from the index', async () => {
    unlinkSync(join(dir, 'src/obsolete.ts'));
    await call('memory_sync');
    const r = (await call('memory_search', { query: 'quokka', mode: 'lexical' })).json();
    expect(r.hits).toHaveLength(0);
  });
  it('detects stale files before searching', async () => {
    writeFileSync(join(dir, 'src/changeable.ts'), "export function version(): string {\n  return 'v3-longer-content';\n}\n");
    const r = (await call('memory_search', { query: 'version', mode: 'lexical' })).json();
    expect(JSON.stringify(r)).toMatch(/stale/i);
  });
  it('reports degraded mode without embeddings and generates docs', async () => {
    const s = (await call('memory_status')).json();
    expect(s.search_mode).toBe('degraded_lexical');
    run(dir, 'docs');
    expect(existsSync(join(dir, '.memory/generated/project-memory.md'))).toBe(true);
    expect(readFileSync(join(dir, '.memory/generated/project-memory.md'), 'utf8')).toContain('AuthService');
  });
});
