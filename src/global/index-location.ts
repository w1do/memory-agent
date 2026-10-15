import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { indexDbPath, indexDir } from './paths.js';

/**
 * Global index.db path for a project. A legacy .memory/index.db is copied once
 * (with WAL/SHM side files) and left in place as a backup.
 */
export function resolveIndexDb(root: string, projectId: string): string {
  const target = indexDbPath(projectId);
  const legacy = join(root, '.memory', 'index.db');
  if (!existsSync(target) && existsSync(legacy)) {
    mkdirSync(indexDir(projectId), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(legacy + suffix)) copyFileSync(legacy + suffix, target + suffix);
    }
  }
  return target;
}
