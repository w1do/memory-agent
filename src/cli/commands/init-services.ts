import { dockerAvailable, startServices } from '../docker.js';
import { assertSharedServiceUp, isLegacyProject } from '../../global/shared-mode.js';
import { MemoryError } from '../../shared/errors.js';

export async function prepareInitServices(root: string): Promise<void> {
  if (isLegacyProject(root)) {
    if (!dockerAvailable().ok) throw new MemoryError('Docker Compose is not available. Install Docker or use --no-start.', 'docker_missing');
    startServices(root);
  } else await assertSharedServiceUp();
}
