import { constants, closeSync, fstatSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { redact } from '../security/redact.js';

type Level = 'info' | 'warn' | 'error';

export interface LogFileStatus { log_path: string | null; log_unavailable_reason?: 'unsupported_platform' }

/** Describes whether this platform supports the secure file logger. */
export function logFileStatus(platform: string, path: string): LogFileStatus {
  return platform === 'linux'
    ? { log_path: path }
    : { log_path: null, log_unavailable_reason: 'unsupported_platform' };
}

/** Linux procfs supplies descriptor-relative lookup without a native openat binding.
 * Only the trusted procfs prefix follows links; every user component is a basename
 * opened with O_NOFOLLOW. Renaming an ancestor cannot redirect an already open fd.
 * Without this facility we fail closed instead of falling back to a racy path.
 */
function openLogDirectory(path: string, create = true): number {
  if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    throw new Error('Secure file logging requires Linux procfs');
  }
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let fd = openSync('/', flags);
  try {
    for (const part of resolve(path).split('/').filter(Boolean)) {
      const child = `/proc/self/fd/${fd}/${part}`;
      let next: number;
      try { next = openSync(child, flags); }
      catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try { mkdirSync(child, { mode: 0o700 }); }
        catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        }
        next = openSync(child, flags);
      }
      const previous = fd;
      fd = next;
      closeSync(previous);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Removes a log without following directory symlinks or creating missing directories. */
export function removeLogFile(path: string): void {
  if (process.platform !== 'linux') return;
  const dir = openLogDirectory(dirname(path), false);
  try { unlinkSync(`/proc/self/fd/${dir}/${basename(path)}`); }
  finally { closeSync(dir); }
}

/** Writes redacted lines to stderr (stdout is reserved for MCP) and optionally to a file. */
export class Logger {
  constructor(private readonly file?: string, private readonly quiet = false) {}

  private write(level: Level, message: string): void {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redact(message)}\n`;
    if (!this.quiet) process.stderr.write(line);
    if (this.file && process.platform === 'linux') {
      try {
        const dir = openLogDirectory(dirname(this.file));
        try {
          const fd = openSync(`/proc/self/fd/${dir}/${basename(this.file)}`,
            constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
          try {
            if (fstatSync(fd).isFile()) writeSync(fd, line);
          } finally { closeSync(fd); }
        } finally { closeSync(dir); }
      } catch { /* logging must never break the command */ }
    }
  }

  info = (m: string) => this.write('info', m);
  warn = (m: string) => this.write('warn', m);
  error = (m: string) => this.write('error', m);
}
