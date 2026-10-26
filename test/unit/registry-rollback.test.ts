import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProjects, registerProject } from '../../src/global/registry.js';
import { scaffold } from '../../src/cli/scaffold.js';

let home: string;
const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'pm-reg-')); dirs.push(d); return d; };
beforeEach(() => { home = tmp(); process.env.PROJECT_MEMORY_HOME = home; });
afterEach(() => { delete process.env.PROJECT_MEMORY_HOME; dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });

describe('registry', () => {
  it('registers a project once and lists it', () => {
    const p = tmp();
    registerProject(p); registerProject(p);
    expect(listProjects()).toEqual([p]);
  });
});

describe('root .gitignore', () => {
  it('replaces .memory/ with a rule that keeps annotations.json, idempotently', async () => {
    const root = tmp();
    writeFileSync(join(root, '.gitignore'), 'node_modules\n.memory/\n');
    await scaffold(root);
    await scaffold(root);
    const text = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(text).toContain('.memory/*');
    expect(text).toContain('!.memory/annotations.json');
    expect(text.match(/annotations\.json/g)).toHaveLength(1);
    expect(text).not.toMatch(/^\.memory\/$/m);
    mkdirSync(root, { recursive: true });
  });
});
