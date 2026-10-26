import { constants, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pinDirectory } from './paths.js';
import { ARTIFACT_PATHS } from './manifest.js';

/** All output paths are relative to retained directory descriptors, never a re-resolved project path. */
export function createDumpDirectory(root: string, name: string) {
  const pins: ReturnType<typeof pinDirectory>[] = [];
  const pin = (path: string) => { const dir = pinDirectory(path); pins.push(dir); return dir; };
  let cleanup = () => {};
  try {
    const project = pin(root);
    const memoryPath = join(project.path, 'memory');
    try { mkdirSync(memoryPath, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const memory = pin(memoryPath), target = join(memory.path, name);
    if (existsSync(target)) throw new Error(`Dump already exists: ${name}`);
    let location = mkdtempSync(join(memory.path, '.dump-incomplete-'));
    const staging = pin(location);
    const children = new Map<string, ReturnType<typeof pinDirectory>>();
    cleanup = () => {
      // Unlink through pinned descriptors. Never recursively remove an attacker-controlled path.
      for (const artifact of [...ARTIFACT_PATHS, 'index.db', 'manifest.json']) {
        if (artifact.includes('/') && !children.has(artifact.split('/')[0])) continue;
        try { unlinkSync(file(artifact)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      for (const [part, child] of children) {
        try { child.assertAt(join(staging.path, part)); rmdirSync(join(staging.path, part)); } catch { /* replaced or moved */ }
      }
      try { staging.assertAt(location); rmdirSync(location); } catch { /* replaced or moved */ }
    };
    for (const part of ['qdrant', 'typesense']) {
      const path = join(staging.path, part);
      mkdirSync(path, { mode: 0o700 }); children.set(part, pin(path));
    }
    function file(path: string): string {
      const parts = path.split('/');
      return parts.length === 1 ? join(staging.path, path) : join(children.get(parts[0])!.path, parts[1]);
    }
    function assertAttached() {
      project.assertAt(root); memory.assertAt(memoryPath); staging.assertAt(location);
      for (const [part, child] of children) child.assertAt(join(staging.path, part));
    }
    return {
      file,
      assertAttached,
      createFile(path: string): number {
        assertAttached();
        return openSync(file(path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      },
      publish() {
        assertAttached();
        // mkdir reserves the destination without following links or overwriting an existing dump.
        mkdirSync(target, { mode: 0o700 });
        try {
          renameSync(location, target);
          location = target;
          assertAttached();
          cleanup = () => {};
        } catch (error) {
          // rename never follows a source link; remove it if a concurrent replacement was published.
          try { unlinkSync(target); } catch { /* target is a directory */ }
          try { rmdirSync(target); } catch { /* preserve nonempty or replaced directories */ }
          throw error;
        }
      },
      close() { try { cleanup(); } finally { for (const dir of pins.reverse()) dir.close(); } },
    };
  } catch (error) {
    try { cleanup(); } finally { for (const dir of pins.reverse()) dir.close(); }
    throw error;
  }
}
