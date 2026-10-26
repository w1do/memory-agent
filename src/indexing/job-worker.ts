import { openContext } from '../shared/context.js';
import { openJobManifest } from './job-manifest.js';
import { finishJob, progressJob, readJob, startJob } from './job-state.js';
import { syncProject } from './sync.js';
import { Logger } from '../shared/logger.js';
import { prepareInitServices } from '../cli/commands/init-services.js';

const [root, id] = process.argv.slice(2);
const manifest = openJobManifest(root);
const job = startJob(manifest, id);
const logger = new Logger(job.log_path ?? undefined, true);
const heartbeat = setInterval(() => {
  const { stage, processed, total } = readJob(manifest, id);
  progressJob(manifest, id, stage, processed, total);
}, 1000);
heartbeat.unref();

async function run(): Promise<void> {
  let ctx;
  try {
    if (job.operation === 'init') {
      progressJob(manifest, id, 'services', 0, 0);
      await prepareInitServices();
    }
    clearInterval(heartbeat);
    ctx = openContext(root, { quiet: true });
    await syncProject(ctx, { kind: job.operation, mode: job.operation === 'init' ? 'structural' : 'full', jobId: id });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    finishJob(manifest, id, error);
    logger.error(error);
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    ctx?.close(); manifest.close();
  }
}
// Startup confirmation happens before services, network calls, or scanning.
if (process.send) process.send({ ready: id }, (error) => {
  if (error) { finishJob(manifest, id, error.message); manifest.close(); process.exitCode = 1; return; }
  void run();
});
else void run();
