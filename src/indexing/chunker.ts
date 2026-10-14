import type { ChunkType, SymbolRecord } from '../shared/types.js';
import { INDENT_LANGUAGES, RULES } from './rules.js';
import { extractExports } from './extract.js';

export interface RawChunk {
  lineStart: number; // 1-based, inclusive
  lineEnd: number;
  symbol: string;
  chunkType: ChunkType;
  content: string;
}

interface Decl { line: number; indent: number; name: string; kind: ChunkType; end: number }

export const MAX_CHUNK_LINES = 80;
const WINDOW = 60;

const indentOf = (l: string) => /^\s*/.exec(l)![0].replace(/\t/g, '    ').length;

function findDecls(lines: string[], language: string): Decl[] {
  const rules = RULES[language] ?? [];
  const decls: Decl[] = [];
  lines.forEach((text, line) => {
    for (const rule of rules) {
      const m = rule.re.exec(text);
      if (m) {
        decls.push({ line, indent: indentOf(text), name: m[1], kind: rule.kind, end: line });
        break;
      }
    }
  });
  return decls;
}

function braceEnd(lines: string[], start: number, limit: number): number {
  let depth = 0;
  let opened = false;
  for (let i = start; i < limit; i++) {
    const cleaned = lines[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '').replace(/\/\/.*$/, '');
    for (const ch of cleaned) {
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}') depth--;
    }
    if (opened && depth <= 0) return i;
    if (!opened && i > start + 6) break;
    if (!opened && /;\s*$/.test(cleaned)) return i;
  }
  return opened ? limit - 1 : start;
}

function indentEnd(lines: string[], start: number, limit: number): number {
  const base = indentOf(lines[start]);
  let end = start;
  for (let i = start + 1; i < limit; i++) {
    if (lines[i].trim() === '') continue;
    if (indentOf(lines[i]) <= base) break;
    end = i;
  }
  return end;
}

function computeEnds(lines: string[], decls: Decl[], language: string): void {
  decls.forEach((d, i) => {
    const next = decls.slice(i + 1).find((n) => n.indent <= d.indent);
    const limit = next ? next.line : lines.length;
    d.end = INDENT_LANGUAGES.has(language) ? indentEnd(lines, d.line, limit) : braceEnd(lines, d.line, limit);
  });
}

const slice = (lines: string[], from: number, to: number) => lines.slice(from, to + 1).join('\n');

function windows(lines: string[], from: number, to: number, symbol: string, type: ChunkType): RawChunk[] {
  const out: RawChunk[] = [];
  for (let s = from; s <= to; s += WINDOW) {
    const e = Math.min(s + WINDOW - 1, to);
    const content = slice(lines, s, e);
    if (content.trim()) out.push({ lineStart: s + 1, lineEnd: e + 1, symbol, chunkType: type, content });
  }
  return out;
}

function declChunks(lines: string[], d: Decl, decls: Decl[]): RawChunk[] {
  if (d.end - d.line + 1 <= MAX_CHUNK_LINES) {
    return [{ lineStart: d.line + 1, lineEnd: d.end + 1, symbol: d.name, chunkType: d.kind, content: slice(lines, d.line, d.end) }];
  }
  const inner = decls.filter((n) => n.line > d.line && n.line <= d.end && n.indent > d.indent);
  const out: RawChunk[] = [];
  let cursor = d.line;
  for (const n of inner) {
    if (n.line < cursor) continue;
    if (n.line > cursor) out.push(...windows(lines, cursor, n.line - 1, d.name, d.kind));
    out.push(...windows(lines, n.line, n.end, `${d.name}.${n.name}`, 'method'));
    cursor = n.end + 1;
  }
  if (cursor <= d.end) out.push(...windows(lines, cursor, d.end, d.name, d.kind));
  return out;
}

function markdownChunks(lines: string[]): RawChunk[] {
  const starts = lines.flatMap((l, i) => (/^#{1,6}\s+\S/.test(l) ? [i] : []));
  if (starts[0] !== 0) starts.unshift(0);
  const out: RawChunk[] = [];
  starts.forEach((s, i) => {
    const e = (starts[i + 1] ?? lines.length) - 1;
    const title = lines[s].replace(/^#+\s*/, '').trim() || 'intro';
    const sectionLines = windows(lines, s, e, title, 'doc_section');
    out.push(...sectionLines);
  });
  return out;
}

export function chunkFile(language: string, content: string, isConfig: boolean): RawChunk[] {
  const lines = content.split('\n');
  if (language === 'markdown') return markdownChunks(lines);
  if (!RULES[language]) return windows(lines, 0, lines.length - 1, '', isConfig ? 'config' : 'lines');

  const decls = findDecls(lines, language);
  computeEnds(lines, decls, language);
  const minIndent = decls.length ? Math.min(...decls.map((d) => d.indent)) : 0;
  const top = decls.filter((d) => d.indent === minIndent);
  const out: RawChunk[] = [];
  let cursor = 0;
  for (const d of top) {
    if (d.line < cursor) continue;
    if (d.line > cursor) out.push(...windows(lines, cursor, d.line - 1, '', 'lines'));
    out.push(...declChunks(lines, d, decls));
    cursor = d.end + 1;
  }
  if (cursor < lines.length) out.push(...windows(lines, cursor, lines.length - 1, '', 'lines'));
  return out.length ? out : windows(lines, 0, lines.length - 1, '', 'lines');
}

export function extractSymbols(language: string, content: string): SymbolRecord[] {
  const lines = content.split('\n');
  const decls = findDecls(lines, language);
  computeEnds(lines, decls, language);
  const exported = new Set(extractExports(language, content));
  return decls.map((d) => ({
    name: d.name, kind: d.kind, lineStart: d.line + 1, lineEnd: d.end + 1, exported: exported.has(d.name),
  }));
}
