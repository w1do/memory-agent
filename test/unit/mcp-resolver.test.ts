import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResolver } from '../../src/mcp/projects.js';

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });

describe('global MCP resolver', () => {
  it('reports a clear error for a directory without initialised memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-mcp-'));
    dirs.push(dir);
    const { resolve } = createResolver(dir);
    expect(() => resolve()).toThrow(/not initialized/);
    expect(() => resolve(dir)).toThrow(/memory init/);
  });
});
