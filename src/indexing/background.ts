import { fork } from 'node:child_process';
import { openJobManifest } from './job-manifest.js';
import { acquireJob, finishJob, getJob, type IndexJob, type JobOperation } from './job-state.js';
import { MemoryError } from '../shared/errors.js';

function workerEnv(operation: JobOperation): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR', 'LANG', 'LC_ALL', 'PROJECT_MEMORY_HOME'];
  if (operation !== 'init') allowed.push('EMBEDDING_API_KEY', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_DIMENSIONS');
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv;
}

export interface JobReply { status: 'accepted' | 'busy'; job_id: string; job: IndexJob }
export interface LaunchOptions { worker?: URL; timeoutMs?: number }

/** The IPC ready message confirms that the detached worker owns the persisted job. */
export async function launchJob(root: string, operation: JobOperation, opts: LaunchOptions = {}): Promise<JobReply> {
  const manifest = openJobManifest(root);
  try {
    const { job, created } = acquireJob(manifest, root, operation);
    if (!created) {
      if (operation !== 'init' || job.operation !== 'init') return { status: 'busy', job_id: job.id, job };
      const deadline = Date.now() + (opts.timeoutMs ?? 8000);
      let current = getJob(manifest, job.id);
      while (current.state === 'queued' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        current = getJob(manifest, job.id);
      }
      if (current.state === 'queued' || current.state === 'failed' || current.state === 'interrupted') {
        throw new MemoryError(`Initialization has not started: ${job.id} (${current.error || current.state})`, 'worker_start_failed');
      }
      return { status: 'accepted', job_id: job.id, job: current };
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const child = fork(opts.worker ?? new URL('./job-worker.js', import.meta.url), [root, job.id], {
          detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [], env: workerEnv(operation),
        });
        const timer = setTimeout(() => fail(new Error('Worker startup timed out')), opts.timeoutMs ?? 8000);
        let settled = false;
        const cleanup = () => { clearTimeout(timer); child.removeListener('error', fail); child.removeListener('exit', exited); child.removeListener('message', ready); };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          child.kill('SIGKILL');
          // Do not release the writer until the failed worker has stopped.
          if (child.exitCode !== null || child.signalCode !== null || !child.pid) reject(error);
          else child.once('exit', () => reject(error));
        };
        const exited = (code: number | null) => fail(new Error(`Worker exited before ready (${code})`));
        const ready = (message: unknown) => {
          if (!message || typeof message !== 'object' || (message as { ready?: string }).ready !== job.id) return;
          settled = true;
          cleanup();
          child.disconnect(); child.unref(); resolve();
        };
        child.once('error', fail); child.once('exit', exited); child.on('message', ready);
      });
      // Read only: all running/progress updates belong to the worker.
      return { status: 'accepted', job_id: job.id, job: getJob(manifest, job.id) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      finishJob(manifest, job.id, message);
      throw new MemoryError(`Worker startup failed: ${message}`, 'worker_start_failed');
    }
  } finally { manifest.close(); }
}
