import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { redact } from '../security/redact.js';

type Level = 'info' | 'warn' | 'error';

/** Writes redacted lines to stderr (stdout is reserved for MCP) and optionally to a file. */
export class Logger {
  constructor(private readonly file?: string, private readonly quiet = false) {}

  private write(level: Level, message: string): void {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redact(message)}\n`;
    if (!this.quiet) process.stderr.write(line);
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        appendFileSync(this.file, line);
      } catch { /* logging must never break the command */ }
    }
  }

  info = (m: string) => this.write('info', m);
  warn = (m: string) => this.write('warn', m);
  error = (m: string) => this.write('error', m);
}
