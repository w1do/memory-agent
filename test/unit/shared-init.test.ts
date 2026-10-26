import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scaffold } from '../../src/cli/scaffold.js';
import { assertSharedServiceUp } from '../../src/global/shared-mode.js';
import { launchJob } from '../../src/indexing/background.js';
import { jobStatus, openJobManifest } from '../../src/indexing/job-manifest.js';
import { acquireJob, getJob, processOwner, readJob, saveJob } from '../../src/indexing/job-state.js';
import { waitJob } from '../../src/indexing/wait-job.js';
import { registerTools } from '../../src/mcp/tools.js';
import type { ContextResolver } from '../../src/mcp/projects.js';
import { buildRoot, buildWorker, removeBuild, fixture, runCli, reply, until, type Fixture } from './shared-init-fixture.js';

let home: string;
let root: string;
let f: Fixture | undefined;
let pids: number[];
const previous = process.env.PROJECT_MEMORY_HOME;
beforeAll(buildWorker);
afterAll(removeBuild);
beforeEach(() => {
  vi.stubEnv('EMBEDDING_API_KEY', '');
  vi.stubEnv('EMBEDDING_BASE_URL', 'https://unconfigured.invalid');
  home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  root = mkdtempSync(join(tmpdir(), 'pm-shared-'));
  process.env.PROJECT_MEMORY_HOME = home;
  pids = [];
});
afterEach(async () => {
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  if (f) { await f.close(); f = undefined; }
  vi.unstubAllEnvs();
  if (previous === undefined) delete process.env.PROJECT_MEMORY_HOME;
  else process.env.PROJECT_MEMORY_HOME = previous;
  rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
});
async function prepare(files = 3) {
  f = await fixture(files);
  process.env.PROJECT_MEMORY_HOME = f.home;
  return f;
}
function launched(stdout: string) { const r = reply(stdout); pids.push(r.job.pid); return r; }

describe('init without Docker (shared mode)', () => {
  it('creates config only: no compose, no project .env, no data dir', async () => {
    const config = await scaffold(root);
    expect(config.qdrantPort).toBe(6333); expect(config.typesensePort).toBe(8108);
    expect(existsSync(join(root, '.memory', 'config.json'))).toBe(true);
    for (const name of ['docker-compose.yml', '.env', 'data']) expect(existsSync(join(root, '.memory', name))).toBe(false);
  });
  it('reports a clear error when the shared service is not running', async () => {
    writeFileSync(join(home, 'global.env'), 'QDRANT_PORT=1\nTYPESENSE_API_KEY=x\n');
    await expect(assertSharedServiceUp()).rejects.toThrow('memory service up');
  });
});

describe('detached init and sync contract', () => {
  it('returns accepted while indexing is blocked and worker survives the CLI parent', async () => {
    const f = await prepare(); f.block = true;
    const r = launched((await runCli(f, 'init')).stdout);
    expect(r.status).toBe('accepted');
    await until(() => f.imports === 3);
    expect(process.kill(r.job.pid, 0)).toBe(true);
    expect(jobStatus(f.root, r.job_id)).toMatchObject({ state: 'running', stage: 'indexing' });
    const before = f.requests.length;
    const status = JSON.parse((await runCli(f, 'status', '--job', r.job_id)).stdout);
    expect(status).toMatchObject({ id: r.job_id, state: 'running', total: 3 });
    expect(f.requests.length).toBe(before);
    f.release();
    expect((await waitJob(f.root, r.job_id)).state).toBe('completed');
    expect(f.embeddings).toBe(0);
  });
  it('--wait stays pending until structural indexing completes and makes no embeddings', async () => {
    const f = await prepare(); f.block = true;
    let returned = false;
    const running = runCli(f, 'init', '--wait').finally(() => { returned = true; });
    await until(() => f.imports === 3);
    expect(returned).toBe(false);
    f.release();
    const output = (await running).stdout;
    expect(output).toContain('"state":"completed"'); expect(output).toContain('Test search:');
    expect(f.embeddings).toBe(0);
  });
  it('preserves --no-index and --no-start without creating an indexing job', async () => {
    const f = await prepare();
    expect((await runCli(f, 'init', '--no-start')).stdout).not.toContain('"status":"accepted"');
    expect(f.requests).toEqual([]);
    expect((await runCli(f, 'init', '--no-index')).stdout).not.toContain('"status":"accepted"');
    expect(f.requests).toEqual(['/healthz']); expect(f.imports).toBe(0);
  });
  it('reports startup failure and leaves no running job', async () => {
    const f = await prepare(); await scaffold(f.root);
    await expect(launchJob(f.root, 'init', { worker: pathToFileURL(join(f.root, 'missing.js')) })).rejects.toThrow('Worker startup failed');
    const manifest = openJobManifest(f.root);
    try { expect(getJob(manifest, manifest.getMeta('active_index_job')!).state).toBe('failed'); }
    finally { manifest.close(); }
  });
  it('times out a worker that never confirms startup', async () => {
    const f = await prepare(); await scaffold(f.root);
    const worker = join(f.home, 'no-ready.cjs'); writeFileSync(worker, 'setInterval(() => {}, 1000)');
    await expect(launchJob(f.root, 'init', { worker: pathToFileURL(worker), timeoutMs: 100 })).rejects.toThrow('timed out');
    const manifest = openJobManifest(f.root);
    try { expect(readJob(manifest, manifest.getMeta('active_index_job')!).state).toBe('failed'); }
    finally { manifest.close(); }
  });
  it('sync --background embeds pending chunks and synchronous sync stays compatible', async () => {
    const f = await prepare(); await runCli(f, 'init', '--wait');
    const r = launched((await runCli(f, 'sync', '--background')).stdout);
    expect(r.status).toBe('accepted');
    expect((await waitJob(f.root, r.job_id)).state).toBe('completed');
    expect(f.embeddings).toBeGreaterThan(0);
    const count = f.embeddings;
    expect((await runCli(f, 'sync')).stdout).toContain('unchanged 3, errors 0');
    expect(f.embeddings).toBe(count);
  });
});

describe('persisted job state and single writer', () => {
  it('atomically admits one worker when two CLI processes initialize concurrently', async () => {
    const f = await prepare(); f.block = true;
    const outputs = await Promise.all([runCli(f, 'init'), runCli(f, 'init')]);
    const replies = outputs.map((o) => launched(o.stdout));
    expect(replies[0].job_id).toBe(replies[1].job_id);
    await until(() => f.imports === 3);
    f.release(); await waitJob(f.root, replies[0].job_id);
    expect(f.imports).toBe(3);
  });
  it('joins active init and returns busy for sync and reindex with the same id', async () => {
    const f = await prepare(); f.block = true;
    const r = launched((await runCli(f, 'init')).stdout);
    await until(() => f.imports === 3);
    expect(reply((await runCli(f, 'init')).stdout).job_id).toBe(r.job_id);
    expect(reply((await runCli(f, 'sync', '--background')).stdout)).toMatchObject({ status: 'busy', job_id: r.job_id });
    await expect(runCli(f, 'sync')).rejects.toThrow(r.job_id);
    await expect(runCli(f, 'reindex', 'f0.ts')).rejects.toThrow(r.job_id);
    f.release(); await waitJob(f.root, r.job_id);
  });
  it('detects a dead owner with stale heartbeat and resumes without losing files', async () => {
    const f = await prepare(); f.block = true;
    const r = launched((await runCli(f, 'init')).stdout);
    await until(() => f.imports === 3);
    process.kill(r.job.pid, 'SIGKILL');
    await until(() => { try { process.kill(r.job.pid, 0); return processOwner(r.job.pid) === 'dead'; } catch { return true; } });
    const manifest = openJobManifest(f.root);
    try { const job = readJob(manifest, r.job_id); job.heartbeat = new Date(0).toISOString(); saveJob(manifest, job); }
    finally { manifest.close(); }
    expect(jobStatus(f.root, r.job_id).state).toBe('interrupted');
    f.block = false; f.release();
    await runCli(f, 'init', '--wait');
    const resumed = openJobManifest(f.root);
    try { expect(resumed.counts()).toMatchObject({ files: 3, errors: 0 }); }
    finally { resumed.close(); }
  });
  it('never completes a job with file errors and stores only redacted errors in its log', async () => {
    const f = await prepare(); f.fail = true;
    const r = launched((await runCli(f, 'init')).stdout);
    const job = await waitJob(f.root, r.job_id);
    expect(job.state).toBe('failed'); expect(job.error).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    if (process.platform === 'linux') {
      expect(job.log_path).not.toBeNull();
      expect(readFileSync(job.log_path!, 'utf8')).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    } else {
      expect(job).toMatchObject({ log_path: null, log_unavailable_reason: 'unsupported_platform' });
    }
  });
  it('persists queued metadata before scanning and keeps the lease for a live owner with an old heartbeat', async () => {
    const f = await prepare(); await scaffold(f.root);
    const manifest = openJobManifest(f.root);
    try {
      const { job } = acquireJob(manifest, f.root, 'init');
      expect(job).toMatchObject({ state: 'queued', stage: 'queued', processed: 0, total: 0, error: '' });
      job.heartbeat = new Date(0).toISOString(); saveJob(manifest, job);
      expect(acquireJob(manifest, f.root, 'sync')).toMatchObject({ created: false, job: { id: job.id } });
      expect(manifest.counts().files).toBe(0);
    } finally { manifest.close(); }
  });
  it('MCP polls saved state without opening context and exposes background sync without memory_init', async () => {
    const f = await prepare(); await scaffold(f.root);
    const manifest = openJobManifest(f.root);
    const { job } = acquireJob(manifest, f.root, 'init'); manifest.close();
    const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }> }>>();
    const resolver: ContextResolver = () => { throw new Error('context must not open'); };
    resolver.root = () => f.root;
    registerTools({ registerTool: (name: string, _schema: unknown, handler: never) => handlers.set(name, handler) } as never, resolver);
    expect(handlers.has('memory_init')).toBe(false);
    const before = f.requests.length;
    expect(JSON.parse((await handlers.get('memory_status')!({ job_id: job.id })).content[0].text)).toMatchObject({ id: job.id, state: 'queued' });
    expect(JSON.parse((await handlers.get('memory_sync')!({ background: true })).content[0].text)).toMatchObject({ status: 'busy', job_id: job.id });
    expect(f.requests.length).toBe(before);
  });
  it('MCP background sync returns accepted from the production worker launcher', async () => {
    const f = await prepare(); await scaffold(f.root);
    const tools = await import(pathToFileURL(join(buildRoot, 'dist/mcp/tools.js')).href);
    const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }> }>>();
    const resolver: ContextResolver = () => { throw new Error('context must not open'); };
    resolver.root = () => f.root;
    tools.registerTools({ registerTool: (name: string, _schema: unknown, handler: never) => handlers.set(name, handler) } as never, resolver);
    const result = JSON.parse((await handlers.get('memory_sync')!({ background: true })).content[0].text);
    expect(result.status).toBe('accepted'); pids.push(result.job.pid);
    const job = await waitJob(f.root, result.job_id);
    // No embedding credentials are supplied: the operation records that failure.
    expect(job.state).toBe('failed'); expect(job.error).toContain('EMBEDDING_API_KEY');
  });
});
