import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertNoSymlink } from '../transfer/paths.js';

export const generationSchema = z.strictObject({
  id: z.string().regex(/^(legacy|[a-f0-9-]{36})$/), projectId: z.string().min(1), collection: z.string().min(1),
  indexPath: z.string(), annotationsPath: z.string(), dumpId: z.string().optional(),
  annotationsHash: z.string().optional(), localHash: z.string().optional(),
});
export type Generation = z.infer<typeof generationSchema>;
export const generationDir = (root: string, id: string): string => {
  generationSchema.shape.id.parse(id);
  assertNoSymlink(root, `.memory/generations/${id}`);
  return join(root, '.memory', 'generations', id);
};
export const pointerPath = (root: string): string => join(root, '.memory', 'active-generation.json');

/** Same-directory POSIX rename is the single publication point; flush data and directory. */
export function durableJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    flushFile(temp);
    renameSync(temp, path);
    flushFile(dirname(path));
  } finally { rmSync(temp, { force: true }); }
}

export function flushFile(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function activeGeneration(root: string): Generation | undefined {
  assertNoSymlink(root, '.memory/active-generation.json');
  if (!existsSync(pointerPath(root))) return undefined;
  return generationSchema.parse(JSON.parse(readFileSync(pointerPath(root), 'utf8')));
}

export function publishGeneration(root: string, generation: Generation): void {
  assertNoSymlink(root, '.memory/active-generation.json');
  durableJson(pointerPath(root), generationSchema.parse(generation));
}

/** Called under the mutation lock; a reader pinned before an import must reopen to write. */
export function assertCurrentGeneration(root: string, id?: string): void {
  if (activeGeneration(root)?.id !== id) throw new Error('Memory generation changed; reopen the project before writing');
}
