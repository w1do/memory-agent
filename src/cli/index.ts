#!/usr/bin/env node
import { Command } from 'commander';
import { handleError } from './common.js';
import { initCommand } from './commands/init.js';
import { startCommand, statusCommand, stopCommand } from './commands/lifecycle.js';
import { reindexCommand, syncCommand, watchCommand } from './commands/indexing.js';
import { docsCommand, mcpCommand, searchCommand } from './commands/search.js';
import { doctorCommand } from './commands/doctor.js';
import { mcpInstallCommand } from './commands/mcp-install.js';
import { serviceDownCommand, serviceLogsCommand, serviceStatusCommand, serviceUpCommand } from './commands/service.js';

const program = new Command('memory').description('Local project code memory for AI agents').version('0.1.0');
const path = '--path <dir>';

const act = <A extends unknown[]>(fn: (...a: A) => unknown) => async (...a: A): Promise<void> => {
  try { await fn(...a); } catch (e) { handleError(e); }
};

const service = program.command('service').description('Manage the shared Qdrant + Typesense stack for all projects');
service.command('up').description('Start shared Qdrant and Typesense once (idempotent)').action(act(serviceUpCommand));
service.command('down').description('Stop shared services (data is kept)').action(act(serviceDownCommand));
service.command('status').description('Show shared service state').action(act(serviceStatusCommand));
service.command('logs').option('--tail <n>', 'number of lines').description('Show shared service logs').action(act(serviceLogsCommand));

program.command('init').description('Create .memory/, start services, index the project')
  .option(path, 'project directory').option('--no-start', 'do not start Docker services')
  .option('--no-index', 'skip initial indexing').option('--yes', 'non-interactive (default behaviour)')
  .option('--wait', 'wait for the structural index; embeddings require memory sync')
  .action(act(initCommand));
program.command('start').option(path).description('Start Qdrant and Typesense').action(act(startCommand));
program.command('stop').option(path).description('Stop services (data is kept)').action(act(stopCommand));
program.command('status').option(path).option('--json').option('--job <id>', 'read saved job progress without scanning or health checks').description('Show index and service status').action(act(statusCommand));
program.command('doctor').option(path).description('Diagnose the environment').action(act(doctorCommand));
program.command('index').option(path).description('Index new and changed files').action(act((o) => syncCommand(o, 'index')));
program.command('sync').option(path).option('--background', 'run sync in a detached worker').description('Sync changes (new, changed, renamed, deleted)').action(act((o) => syncCommand(o)));
program.command('watch').option(path).description('Watch files and update the index').action(act(watchCommand));
program.command('reindex [paths...]').option(path)
  .description('Rebuild Qdrant and Typesense from source, or only the given paths')
  .action(act((paths: string[], o: { path?: string }) => reindexCommand(o, paths)));
program.command('docs').option(path).description('Generate .memory/generated/project-memory.md').action(act(docsCommand));
const mcp = program.command('mcp').option('--project <dir>', 'absolute project path')
  .description('Run MCP server over stdio (or install it into AI agents with "mcp install")').action(act(mcpCommand));
mcp.command('install').option(path).option('--agents <list>', 'claude,junie,codex,opencode (default: interactive, all)')
  .option('--global', 'install into user-level agent configs (works in any project, no --project)')
  .description('Add project-memory MCP server to selected agents configs (project or --global)').action(act(mcpInstallCommand));
program.command('search <query>').option(path).option('--mode <mode>', 'hybrid|lexical|semantic')
  .option('--limit <n>').option('--language <lang>').option('--max-chars <n>').option('--json')
  .option('--snippets', 'show symbols, scores and code snippets (default: paths only)')
  .description('Search project memory').action(act(searchCommand));

program.parseAsync().catch(handleError);
