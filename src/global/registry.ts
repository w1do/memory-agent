import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { globalDir } from './paths.js';
import { join } from 'node:path';

export const registryPath = (): string => join(globalDir(), 'projects.json');

export function listProjects(): string[] {
  try { return existsSync(registryPath()) ? (JSON.parse(readFileSync(registryPath(), 'utf8')) as string[]) : []; } catch { return []; }
}

export function registerProject(root: string): void {
  const abs = resolve(root);
  const all = listProjects();
  if (all.includes(abs)) return;
  mkdirSync(dirname(registryPath()), { recursive: true });
  writeFileSync(registryPath(), JSON.stringify([...all, abs].sort(), null, 2) + '\n');
}
