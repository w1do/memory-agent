#!/usr/bin/env node
import { Command } from 'commander';
import { handleError } from './common.js';
import { initCommand } from './commands/init.js';
import { startCommand, statusCommand, stopCommand } from './commands/lifecycle.js';
import { reindexCommand, syncCommand, watchCommand } from './commands/indexing.js';
import { docsCommand, mcpCommand, searchCommand } from './commands/search.js';
import { doctorCommand } from './commands/doctor.js';

const program = new Command('memory').description('Local project code memory for AI agents').version('0.1.0');
const path = '--path <dir>';

const act = <A extends unknown[]>(fn: (...a: A) => unknown) => async (...a: A): Promise<void> => {
  try { await fn(...a); } catch (e) { handleError(e); }
};

program.command('init').description('Create .memory/, start services, index the project')
  .option(path, 'project directory').option('--no-start', 'do not start Docker services')
  .option('--no-index', 'skip initial indexing').option('--yes', 'non-interactive (default behaviour)')
  .action(act(initCommand));
program.command('start').option(path).description('Start Qdrant and Typesense').action(act(startCommand));
program.command('stop').option(path).description('Stop services (data is kept)').action(act(stopCommand));
program.command('status').option(path).option('--json').description('Show index and service status').action(act(statusCommand));
program.command('doctor').option(path).description('Diagnose the environment').action(act(doctorCommand));
program.command('index').option(path).description('Index new and changed files').action(act((o) => syncCommand(o, 'index')));
program.command('sync').option(path).description('Sync changes (new, changed, renamed, deleted)').action(act((o) => syncCommand(o)));
program.command('watch').option(path).description('Watch files and update the index').action(act(watchCommand));
program.command('reindex [paths...]').option(path)
  .description('Rebuild Qdrant and Typesense from source, or only the given paths')
  .action(act((paths: string[], o: { path?: string }) => reindexCommand(o, paths)));
program.command('docs').option(path).description('Generate .memory/generated/project-memory.md').action(act(docsCommand));
program.command('mcp').requiredOption('--project <dir>', 'absolute project path')
  .description('Run MCP server over stdio').action(act(mcpCommand));
program.command('search <query>').option(path).option('--mode <mode>', 'hybrid|lexical|semantic')
  .option('--limit <n>').option('--language <lang>').option('--max-chars <n>').option('--json')
  .description('Search project memory').action(act(searchCommand));

program.parseAsync().catch(handleError);
