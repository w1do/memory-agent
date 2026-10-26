import type { MemoryContext } from '../shared/context.js';
import { Logger } from '../shared/logger.js';
import { acquireJob, busy, finishJob, progressJob, readJob, startJob, type JobOperation } from './job-state.js';

export interface JobProgress { stage: string; processed: number; total: number }
export type Progress = (progress: JobProgress) => void;

/** Every structural writer takes the same persisted lease before doing network work or scanning. */
export async function withWriter<T>(
  ctx: MemoryContext, operation: JobOperation, work: (progress: Progress) => Promise<T>,
  errorOf: (result: T) => string, jobId?: string,
): Promise<T> {
  let job;
  if (jobId) {
    job = readJob(ctx.manifest, jobId);
    if (job.state !== 'running' || job.pid !== process.pid) throw busy(job);
  } else {
    const claimed = acquireJob(ctx.manifest, ctx.root, operation);
    if (!claimed.created) throw busy(claimed.job);
    job = startJob(ctx.manifest, claimed.job.id);
  }
  const logger = new Logger(job.log_path ?? undefined, true);
  let progress: JobProgress = { stage: 'starting', processed: 0, total: 0 };
  const publish: Progress = (p) => { progress = p; progressJob(ctx.manifest, job.id, p.stage, p.processed, p.total); };
  const heartbeat = setInterval(() => publish(progress), 1000);
  heartbeat.unref();
  try {
    logger.info(`${job.operation} started`);
    const result = await work(publish);
    const error = errorOf(result);
    finishJob(ctx.manifest, job.id, error, result);
    if (error) logger.error(error); else logger.info('completed');
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    finishJob(ctx.manifest, job.id, error);
    logger.error(error);
    throw e;
  } finally { clearInterval(heartbeat); }
}
