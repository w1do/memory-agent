import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from '../storage/manifest.js';
import { memoryDir } from '../project/config.js';
import { MemoryError } from '../shared/errors.js';
import { redact } from '../security/redact.js';
import { Logger, logFileStatus, removeLogFile } from '../shared/logger.js';

export type JobOperation = 'init' | 'sync' | 'update';
export interface IndexJob {
  id: string; operation: JobOperation; state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  stage: string; processed: number; total: number; heartbeat: string; error: string;
  log_path: string | null; log_unavailable_reason?: 'unsupported_platform';
  pid: number; owner: string; result?: unknown;
}
const ACTIVE = 'active_index_job';
const MAX_RESULT_BYTES = 64 * 1024;
export const MAX_RETAINED_JOBS = 50;
export const HEARTBEAT_STALE_MS = 30_000;
const key = (id: string) => `index_job:${id}`;
export const isActive = (job: IndexJob): boolean => job.state === 'queued' || job.state === 'running';

/** Linux start time also guards against PID reuse. Other platforms use process liveness. */
export function processOwner(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? 'dead' : fields[19];
  } catch { return ''; }
}
function alive(job: IndexJob): boolean {
  try { process.kill(job.pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
  const owner = processOwner(job.pid);
  return owner !== 'dead' && (!job.owner || !owner || owner === job.owner);
}
export function readJob(manifest: Manifest, id: string): IndexJob {
  const raw = manifest.getMeta(key(id));
  if (!raw) throw new MemoryError(`Unknown index job: ${id}`, 'job_not_found');
  return JSON.parse(raw) as IndexJob;
}
export function saveJob(manifest: Manifest, job: IndexJob): void {
  manifest.setMeta(key(job.id), JSON.stringify(job));
}
function reconcile(manifest: Manifest, job: IndexJob): IndexJob {
  // A live owner keeps the lease even if synchronous scanning delays its heartbeat.
  const stale = Date.now() - Date.parse(job.heartbeat) >= HEARTBEAT_STALE_MS;
  if (isActive(job) && stale && !alive(job)) {
    job.state = 'interrupted';
    job.error = `Owner exited; last heartbeat ${job.heartbeat}`;
    saveJob(manifest, job);
  }
  return job;
}
export function getJob(manifest: Manifest, id: string): IndexJob {
  return manifest.tx(() => reconcile(manifest, readJob(manifest, id)), true);
}
function removeJobLogs(paths: string[]): void {
  for (const path of paths) {
    try { removeLogFile(path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') new Logger().warn(`Job log cleanup failed (${code ?? 'unknown error'})`);
    }
  }
}
export function acquireJob(manifest: Manifest, root: string, operation: JobOperation): { job: IndexJob; created: boolean } {
  let logs: string[] = [];
  const claimed = manifest.tx(() => {
    const active = manifest.getMeta(ACTIVE);
    const raw = active ? manifest.getMeta(key(active)) : undefined;
    if (active && !raw) {
      new Logger().warn(`Clearing stale active index job reference (${active}): job record is missing`);
      manifest.deleteMeta(ACTIVE);
    }
    const current = raw ? reconcile(manifest, JSON.parse(raw) as IndexJob) : undefined;
    if (current && isActive(current)) {
      logs = manifest.pruneIndexJobs(MAX_RETAINED_JOBS, current.id);
      return { job: current, created: false };
    }
    const id = randomUUID();
    const log = logFileStatus(process.platform, join(memoryDir(root), 'logs', `job-${id}.log`));
    const job: IndexJob = {
      id, operation, state: 'queued', stage: 'queued', processed: 0, total: 0,
      heartbeat: new Date().toISOString(), error: '', ...log,
      pid: process.pid, owner: processOwner(process.pid),
    };
    saveJob(manifest, job);
    manifest.setMeta(ACTIVE, id);
    logs = manifest.pruneIndexJobs(MAX_RETAINED_JOBS, id);
    return { job, created: true };
  }, true);
  removeJobLogs(logs);
  return claimed;
}
export function startJob(manifest: Manifest, id: string): IndexJob {
  return manifest.tx(() => {
    const job = readJob(manifest, id);
    if (manifest.getMeta(ACTIVE) !== id || job.state !== 'queued') throw new MemoryError(`Job cannot start: ${id}`, 'job_not_queued');
    Object.assign(job, { state: 'running', pid: process.pid, owner: processOwner(process.pid), heartbeat: new Date().toISOString() });
    saveJob(manifest, job);
    return job;
  }, true);
}
export function progressJob(manifest: Manifest, id: string, stage: string, processed: number, total: number): void {
  const job = readJob(manifest, id);
  if (!isActive(job) || job.pid !== process.pid) return;
  Object.assign(job, { stage, processed, total, heartbeat: new Date().toISOString() });
  saveJob(manifest, job);
}
export function finishJob(manifest: Manifest, id: string, error = '', result?: unknown): IndexJob {
  let logs: string[] = [];
  const job = manifest.tx(() => {
    const job = readJob(manifest, id);
    if (!isActive(job)) return job;
    if (job.operation === 'update' && Array.isArray(result)) result = { paths: result.length };
    if (result !== undefined && Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) result = undefined;
    Object.assign(job, { state: error ? 'failed' : 'completed', stage: 'finished', error: redact(error), result, heartbeat: new Date().toISOString() });
    saveJob(manifest, job);
    logs = manifest.pruneIndexJobs(MAX_RETAINED_JOBS, id);
    return job;
  }, true);
  removeJobLogs(logs);
  return job;
}
export function busy(job: IndexJob): MemoryError {
  return Object.assign(new MemoryError(`busy: active index job ${job.id} (${job.operation})`, 'busy'), { job_id: job.id });
}
