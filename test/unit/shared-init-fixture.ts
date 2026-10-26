import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export let buildRoot: string;
export let cli: string;
export async function buildWorker(): Promise<void> {
  buildRoot = mkdtempSync(join(tmpdir(), 'pm-worker-build-'));
  symlinkSync(resolve('node_modules'), join(buildRoot, 'node_modules'), 'dir');
  writeFileSync(join(buildRoot, 'package.json'), '{"type":"module"}');
  await exec(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--outDir', join(buildRoot, 'dist')]);
  cli = join(buildRoot, 'dist/cli/index.js');
}
export const removeBuild = () => rmSync(buildRoot, { recursive: true, force: true });

export interface Fixture {
  root: string; home: string; port: number; requests: string[]; imports: number; embeddings: number;
  block: boolean; fail: boolean; release(): void; close(): Promise<void>;
}
export async function fixture(files = 3): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'pm-init-project-'));
  const home = mkdtempSync(join(tmpdir(), 'pm-init-home-'));
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f: Fixture = { root, home, port: 0, requests: [], imports: 0, embeddings: 0, block: false, fail: false, release, close: async () => {} };
  for (let i = 0; i < files; i++) writeFileSync(join(root, `f${i}.ts`), `export const n${i} = ${i};\n`);
  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? '';
    f.requests.push(url);
    let body = '';
    for await (const data of req) body += data;
    if (url.includes('/documents/import')) {
      // Typesense returns bulk import results as JSONL, not one JSON document.
      res.setHeader('content-type', 'text/plain');
      f.imports++;
      if (f.block) await gate;
      res.end(body.trim().split('\n').map(() => JSON.stringify(f.fail ? { success: false, error: 'token=sk-abcdefghijklmnopqrstuvwx' } : { success: true })).join('\n'));
    } else if (url.includes('/embeddings')) {
      res.setHeader('content-type', 'application/json');
      f.embeddings++;
      res.end(JSON.stringify({ data: JSON.parse(body).input.map((_: unknown, index: number) => ({ index, embedding: [0.1, 0.2] })) }));
    } else {
      res.setHeader('content-type', 'application/json');
      if (url.includes('/documents/search')) res.end('{"hits":[]}');
      else if (url.includes('/exists')) res.end('{"result":{"exists":false},"status":"ok"}');
      else if (url.includes('/collections/')) res.end('{"fields":[{"name":"summary"}],"num_documents":0,"result":{"status":"ok"},"status":"ok"}');
      else res.end('{"ok":true,"result":true,"status":"ok"}');
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Fixture server listen timed out after 5 seconds')), 5_000);
      server.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      server.listen(0, '127.0.0.1', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  } catch (error) {
    try { server.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  f.port = (server.address() as { port: number }).port;
  writeFileSync(join(home, 'global.env'), `QDRANT_PORT=${f.port}\nTYPESENSE_PORT=${f.port}\nTYPESENSE_API_KEY=test-only\n`);
  f.close = async () => {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  };
  return f;
}
export function runCli(f: Fixture, ...args: string[]) {
  return exec(process.execPath, [cli, ...args, '--path', f.root], {
    env: { ...process.env, PROJECT_MEMORY_HOME: f.home, EMBEDDING_API_KEY: '', EMBEDDING_BASE_URL: `http://127.0.0.1:${f.port}/v1`, EMBEDDING_DIMENSIONS: '2' },
    timeout: 30_000,
  });
}
export async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
export function reply(stdout: string): { status: string; job_id: string; job: { pid: number } } {
  const line = stdout.split('\n').find((s) => s.startsWith('{"status":'));
  if (!line) throw new Error(`No job reply: ${stdout}`);
  return JSON.parse(line);
}
