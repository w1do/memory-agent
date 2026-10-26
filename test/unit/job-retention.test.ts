import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Manifest } from '../../src/storage/manifest.js';
import { loadMatcher } from '../../src/project/scan.js';
import type { MemoryContext } from '../../src/shared/context.js';
import { acquireJob, finishJob, MAX_RETAINED_JOBS, readJob, saveJob, type IndexJob } from '../../src/indexing/job-state.js';
import { updatePaths } from '../../src/indexing/update.js';

let root: string;
let manifest: Manifest;
let reader: DatabaseSync;
const logs = () => join(root, '.memory', 'logs');
const jobs = () => reader.prepare("SELECT value FROM meta WHERE key GLOB 'index_job:*'")
  .all().map((row) => JSON.parse(row.value as string) as IndexJob);
function seedHistory(): IndexJob[] {
  return Array.from({ length: MAX_RETAINED_JOBS + 3 }, (_, i) => {
    const state = (['completed', 'failed', 'interrupted'] as const)[i % 3];
    const job: IndexJob = {
      id: `seed-${i}`, operation: 'update', state, stage: 'finished', processed: 0, total: 0,
      heartbeat: new Date(i * 1000).toISOString(), error: '', pid: process.pid, owner: '',
      log_path: process.platform === 'linux' ? join(logs(), `job-seed-${i}.log`) : null,
    };
    saveJob(manifest, job);
    if (job.log_path) writeFileSync(job.log_path, 'completed');
    return job;
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pm-retention-'));
  mkdirSync(logs(), { recursive: true });
  manifest = new Manifest(join(root, '.memory', 'index.db'));
  reader = new DatabaseSync(join(root, '.memory', 'index.db'), { readOnly: true });
});
afterEach(() => {
  vi.restoreAllMocks(); reader.close(); manifest.close();
  rmSync(root, { recursive: true, force: true });
});

describe('index job retention', () => {
  it('bounds completed updatePaths jobs and their logs while returning full path results', async () => {
    const ctx = { root, manifest, matcher: loadMatcher(root), typesense: { ensureCollection: async () => {} } } as unknown as MemoryContext;
    let oldest = '';
    for (let i = 0; i < MAX_RETAINED_JOBS + 5; i++) {
      expect(await updatePaths(ctx, ['missing.ts'])).toEqual([{ path: 'missing.ts', status: 'skipped', reason: 'not found' }]);
      oldest ||= manifest.getMeta('active_index_job')!;
      expect(jobs().length).toBeLessThanOrEqual(MAX_RETAINED_JOBS + 1);
    }
    expect(jobs()).toHaveLength(MAX_RETAINED_JOBS + 1);
    expect(jobs().every((job) => job.state === 'completed')).toBe(true);
    expect(manifest.getMeta(`index_job:${oldest}`)).toBeUndefined();
    expect(readJob(manifest, manifest.getMeta('active_index_job')!).result).toEqual({ paths: 1 });
    if (process.platform === 'linux') {
      expect(existsSync(join(logs(), `job-${oldest}.log`))).toBe(false);
      expect(readdirSync(logs())).toHaveLength(MAX_RETAINED_JOBS + 1);
    }
  });

  it.each(['queued', 'running'] as const)('keeps a live %s job and prunes the oldest terminal jobs after commit', (state) => {
    const active = acquireJob(manifest, root, 'init').job;
    active.state = state; active.heartbeat = new Date(0).toISOString(); saveJob(manifest, active);
    const history = seedHistory();
    if (active.log_path) writeFileSync(active.log_path, 'active');
    const prune = manifest.pruneIndexJobs.bind(manifest);
    vi.spyOn(manifest, 'pruneIndexJobs').mockImplementation((retain) => {
      const removed = prune(retain);
      expect(reader.prepare('SELECT value FROM meta WHERE key=?').get(`index_job:${history[0].id}`)).toBeDefined();
      for (const job of history) if (job.log_path) expect(existsSync(job.log_path)).toBe(true);
      return removed;
    });
    expect(acquireJob(manifest, root, 'update')).toMatchObject({ created: false, job: { id: active.id, state } });
    expect(jobs()).toHaveLength(MAX_RETAINED_JOBS + 1);
    expect(reader.prepare("SELECT value FROM meta WHERE key='active_index_job'").get()?.value).toBe(active.id);
    for (const [i, job] of history.entries()) {
      expect(!!manifest.getMeta(`index_job:${job.id}`)).toBe(i >= 3);
      if (job.log_path) expect(existsSync(job.log_path)).toBe(i >= 3);
    }
    if (active.log_path) expect(existsSync(active.log_path)).toBe(true);
  });

  it('keeps the finished active job when the clock moves behind retained heartbeats', () => {
    const current = acquireJob(manifest, root, 'init').job;
    current.state = 'running';
    current.heartbeat = new Date().toISOString();
    saveJob(manifest, current);
    const history = seedHistory();
    for (const job of history) {
      job.heartbeat = new Date(Date.now() + 60_000 + Number(job.id.slice(5)) * 1000).toISOString();
      saveJob(manifest, job);
    }

    expect(finishJob(manifest, current.id).state).toBe('completed');
    expect(manifest.getMeta(`index_job:${current.id}`)).toBeTruthy();
    expect(jobs()).toHaveLength(MAX_RETAINED_JOBS + 1);
    expect(acquireJob(manifest, root, 'update').created).toBe(true);
  });

  it('clears a missing active reference with a warning and starts a new job', () => {
    manifest.setMeta('active_index_job', 'missing-job');
    const warning = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(acquireJob(manifest, root, 'update').created).toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('job record is missing'));
    expect(manifest.getMeta('active_index_job')).not.toBe('missing-job');
  });

  it('summarizes large updates without truncating the caller result', async () => {
    const ctx = { root, manifest, matcher: loadMatcher(root), typesense: { ensureCollection: async () => {} } } as unknown as MemoryContext;
    const result = await updatePaths(ctx, Array.from({ length: 1000 }, (_, i) => `missing-${i}.ts`));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(64 * 1024);
    expect(result).toHaveLength(1000);
    expect(readJob(manifest, manifest.getMeta('active_index_job')!)).toMatchObject({ state: 'completed', result: { paths: 1000 } });
  });

  it('rolls back record removal and leaves logs intact if acquisition fails', () => {
    const history = seedHistory();
    vi.spyOn(manifest, 'setMeta').mockImplementation(() => { throw new Error('write failed'); });
    expect(() => acquireJob(manifest, root, 'update')).toThrow('write failed');
    expect(jobs()).toHaveLength(history.length);
    for (const job of history) if (job.log_path) expect(existsSync(job.log_path)).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')('tolerates missing logs and unlink errors after committing records', () => {
    const history = seedHistory();
    rmSync(history[0].log_path!);
    rmSync(history[1].log_path!); mkdirSync(history[1].log_path!);
    const warning = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(acquireJob(manifest, root, 'update').created).toBe(true);
    expect(jobs()).toHaveLength(MAX_RETAINED_JOBS + 1);
    expect(manifest.getMeta(`index_job:${history[1].id}`)).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Job log cleanup failed'));
  });
});
