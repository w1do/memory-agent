import { homedir } from 'node:os';
import { join } from 'node:path';

/** Machine-wide storage: shared service config and derived project indexes. */
export const globalDir = (): string => {
  const override = process.env.PROJECT_MEMORY_HOME;
  return override && override.length > 0 ? override : join(homedir(), '.config', 'project-memory');
};

export const globalEnvPath = (): string => join(globalDir(), 'global.env');
export const globalComposePath = (): string => join(globalDir(), 'docker-compose.yml');
export const indexDir = (projectId: string): string => join(globalDir(), 'index', projectId);
export const indexDbPath = (projectId: string): string => join(indexDir(projectId), 'index.db');
