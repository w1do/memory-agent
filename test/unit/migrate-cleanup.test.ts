import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupLeftovers } from '../../src/global/migrate.js';

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'pm-clean-')); dirs.push(d); return d; };
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });

describe('cleanupLeftovers', () => {
  it('removes old data, compose and local index when the global index exists', () => {
    const base = tmp();
    process.env.PROJECT_MEMORY_HOME = join(base, 'home');
    const root = join(base, 'proj');
    const dir = join(root, '.memory');
    mkdirSync(join(dir, 'data', 'qdrant'), { recursive: true });
    writeFileSync(join(dir, 'docker-compose.yml.old'), '');
    writeFileSync(join(dir, '.env.example'), '');
    writeFileSync(join(dir, 'index.db'), '');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ projectId: 'p1', projectName: 'p', root, collection: 'c', host: '127.0.0.1', qdrantPort: 6333, typesensePort: 8108, embedding: { baseUrl: '', model: '', dimensions: 1536 }, maxFileSize: 1 }));
    mkdirSync(join(base, 'home', 'index', 'p1'), { recursive: true });
    writeFileSync(join(base, 'home', 'index', 'p1', 'index.db'), '');
    const removed = cleanupLeftovers(root);
    delete process.env.PROJECT_MEMORY_HOME;
    expect(removed.length).toBe(4);
    expect(existsSync(join(dir, 'data'))).toBe(false);
    expect(existsSync(join(dir, 'index.db'))).toBe(false);
    expect(existsSync(join(dir, 'config.json'))).toBe(true);
  });
});
