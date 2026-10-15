import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateProject, scanLegacy } from '../../src/global/migrate.js';

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'pm-mig-')); dirs.push(d); return d; };
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });

describe('migrate', () => {
  it('skips a project without legacy compose (idempotent no-op)', async () => {
    const r = await migrateProject(tmp());
    expect(r.status).toBe('skipped');
  });
  it('scan finds legacy projects only', () => {
    const base = tmp();
    mkdirSync(join(base, 'a', '.memory'), { recursive: true });
    writeFileSync(join(base, 'a', '.memory', 'docker-compose.yml'), '');
    mkdirSync(join(base, 'b', '.memory'), { recursive: true });
    expect(scanLegacy(base)).toEqual([join(base, 'a')]);
  });
  it('reports an error instead of throwing when the shared service is down', async () => {
    const base = tmp();
    process.env.PROJECT_MEMORY_HOME = join(base, 'home');
    mkdirSync(join(base, '.memory'), { recursive: true });
    writeFileSync(join(base, '.memory', 'docker-compose.yml'), '');
    const r = await migrateProject(base);
    delete process.env.PROJECT_MEMORY_HOME;
    expect(r.status).toBe('error');
  });
});
