import { dockerComposeAvailable, serviceDown, serviceLogs, serviceStatus, serviceUp } from '../../global/service.js';
import { globalDir } from '../../global/paths.js';
import { MemoryError } from '../../shared/errors.js';

const requireDocker = (): void => {
  if (!dockerComposeAvailable()) throw new MemoryError('Docker Compose is not available. Install Docker first.', 'docker_missing');
};

export function serviceUpCommand(): void {
  requireDocker();
  console.log(`Shared service config: ${globalDir()}/global.env (mode 600)`);
  console.log('Starting shared Qdrant and Typesense (idempotent)…');
  serviceUp();
  console.log('Shared service is up on 127.0.0.1. Run "memory init" in any project.');
}

export function serviceDownCommand(): void {
  requireDocker();
  serviceDown();
  console.log('Shared service stopped. Data is kept.');
}

export function serviceStatusCommand(): void {
  requireDocker();
  const r = serviceStatus();
  console.log(r.output || 'Shared service is not running. Run "memory service up".');
}

export function serviceLogsCommand(opts: { tail?: string }): void {
  requireDocker();
  const r = serviceLogs(Number(opts.tail ?? 200));
  console.log(r.output);
}
