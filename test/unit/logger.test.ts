import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger, logFileStatus } from '../../src/shared/logger.js';

const hooks = vi.hoisted(() => ({
  beforeOpen: undefined as ((path: string) => void) | undefined,
  afterMkdir: undefined as ((path: string) => void) | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn<typeof actual.openSync>((path, flags, mode) => {
      hooks.beforeOpen?.(String(path));
      return actual.openSync(path, flags, mode);
    }),
    mkdirSync: vi.fn((path, options) => {
      const result = actual.mkdirSync(path, options);
      hooks.afterMkdir?.(String(path));
      return result;
    }),
    closeSync: vi.fn(actual.closeSync),
  };
});

let root: string;
let outside: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'pm-logger-'));
  outside = fs.mkdtempSync(join(tmpdir(), 'pm-logger-outside-'));
  hooks.beforeOpen = undefined; hooks.afterMkdir = undefined;
  vi.clearAllMocks();
});
afterEach(() => {
  hooks.beforeOpen = undefined; hooks.afterMkdir = undefined;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
function log(): void { new Logger(join(root, 'logs', 'job.log'), true).info('key=sk-abcdefghijklmnopqrstuvwx'); }
function expectClosed(): void {
  const opened = vi.mocked(fs.openSync).mock.results.filter((r) => r.type === 'return').map((r) => r.value);
  expect(vi.mocked(fs.closeSync).mock.calls.map(([fd]) => fd).sort()).toEqual(opened.sort());
}

describe('file log availability', () => {
  it('reports no path and an explicit reason on unsupported platforms', () => {
    expect(logFileStatus('darwin', '/memory/logs/job.log')).toEqual({
      log_path: null,
      log_unavailable_reason: 'unsupported_platform',
    });
  });
  it('preserves the log path on Linux', () => {
    expect(logFileStatus('linux', '/memory/logs/job.log')).toEqual({ log_path: '/memory/logs/job.log' });
  });
});

describe.skipIf(process.platform !== 'linux')('descriptor-relative log files', () => {
  it('creates private directories and appends redacted lines, closing every descriptor', () => {
    log(); log();
    const file = join(root, 'logs', 'job.log');
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(join(root, 'logs')).mode & 0o777).toBe(0o700);
    expectClosed();
  });
  it('refuses a symlink directory', () => {
    fs.symlinkSync(outside, join(root, 'logs'));
    log();
    expect(fs.readdirSync(outside)).toEqual([]);
    expectClosed();
  });
  it('refuses a symlink in an ancestor of the log directory', () => {
    fs.symlinkSync(outside, join(root, 'ancestor'));
    new Logger(join(root, 'ancestor', 'logs', 'job.log'), true).info('message');
    expect(fs.readdirSync(outside)).toEqual([]);
    expectClosed();
  });
  it('refuses a symlink file without appending to its target', () => {
    fs.mkdirSync(join(root, 'logs'));
    const target = join(outside, 'target');
    fs.writeFileSync(target, 'unchanged');
    fs.symlinkSync(target, join(root, 'logs', 'job.log'));
    log();
    expect(fs.readFileSync(target, 'utf8')).toBe('unchanged');
    expectClosed();
  });
  it('rejects a directory replaced with a symlink just before opening it', () => {
    fs.mkdirSync(join(root, 'logs'));
    hooks.beforeOpen = (path) => {
      if (!path.endsWith('/logs')) return;
      hooks.beforeOpen = undefined;
      fs.renameSync(join(root, 'logs'), join(root, 'saved'));
      fs.symlinkSync(outside, join(root, 'logs'));
    };
    log();
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readdirSync(join(root, 'saved'))).toEqual([]);
    expectClosed();
  });
  it('keeps writing to the pinned directory if its pathname is replaced', () => {
    fs.mkdirSync(join(root, 'logs'));
    hooks.beforeOpen = (path) => {
      if (!path.endsWith('/job.log')) return;
      hooks.beforeOpen = undefined;
      fs.renameSync(join(root, 'logs'), join(root, 'saved'));
      fs.symlinkSync(outside, join(root, 'logs'));
    };
    log();
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(join(root, 'saved', 'job.log'), 'utf8')).toContain('INFO');
    expectClosed();
  });
  it('rejects a newly created directory replaced with a symlink before open', () => {
    hooks.afterMkdir = (path) => {
      if (!path.endsWith('/logs')) return;
      hooks.afterMkdir = undefined;
      fs.rmdirSync(path);
      fs.symlinkSync(outside, path);
    };
    log();
    expect(fs.readdirSync(outside)).toEqual([]);
    expectClosed();
  });
  it('skips file logging if descriptor-relative lookup is unavailable', () => {
    hooks.beforeOpen = (path) => {
      if (path.startsWith('/proc/self/fd/')) throw Object.assign(new Error('procfs unavailable'), { code: 'ENOENT' });
    };
    expect(log).not.toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
    expectClosed();
  });
});
