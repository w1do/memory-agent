import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold } from '../../src/cli/scaffold.js';
import { assertSharedServiceUp } from '../../src/global/shared-mode.js';

let home: string;
let root: string;
const previous = process.env.PROJECT_MEMORY_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  root = mkdtempSync(join(tmpdir(), 'pm-shared-'));
  process.env.PROJECT_MEMORY_HOME = home;
});

afterEach(() => {
  if (previous === undefined) delete process.env.PROJECT_MEMORY_HOME;
  else process.env.PROJECT_MEMORY_HOME = previous;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('init without Docker (shared mode)', () => {
  it('creates config only: no compose, no project .env, no data dir', async () => {
    const config = await scaffold(root);
    expect(config.qdrantPort).toBe(6333);
    expect(config.typesensePort).toBe(8108);
    expect(existsSync(join(root, '.memory', 'config.json'))).toBe(true);
    for (const f of ['docker-compose.yml', '.env', 'data']) expect(existsSync(join(root, '.memory', f))).toBe(false);
  });

  it('reports a clear error when the shared service is not running', async () => {
    process.env.QDRANT_PORT_TEST = '1';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(home, 'global.env'), 'QDRANT_PORT=1\nTYPESENSE_API_KEY=x\n');
    await expect(assertSharedServiceUp()).rejects.toThrow('memory service up');
  });
});
