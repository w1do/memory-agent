import { redact } from '../security/redact.js';
import { MemoryError } from '../shared/errors.js';

export interface ToolResult { [key: string]: unknown; content: Array<{ type: 'text'; text: string }>; isError?: boolean }

export const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: redact(JSON.stringify(data, null, 1)) }],
});

/** Errors are converted to safe messages: no stack traces, no secrets. */
export const fail = (e: unknown): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: redact(JSON.stringify({
    error: e instanceof MemoryError ? e.code : 'internal_error',
    message: e instanceof Error ? e.message : String(e),
  })) }],
});

export const safe = <A>(fn: (args: A) => Promise<unknown> | unknown) => async (args: A): Promise<ToolResult> => {
  try { return ok(await fn(args)); } catch (e) { return fail(e); }
};
