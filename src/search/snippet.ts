import { redact } from '../security/redact.js';

export const tokenize = (q: string): string[] =>
  q.toLowerCase().split(/[^\p{L}\p{N}_$]+/u).filter((t) => t.length > 1);

/** Short excerpt around the best-matching line of a chunk. Never returns the whole chunk. */
export function makeSnippet(content: string, query: string, maxChars = 400): string {
  const terms = tokenize(query);
  const lines = content.split('\n');
  let best = 0;
  let bestScore = -1;
  lines.forEach((l, i) => {
    const low = l.toLowerCase();
    const score = terms.filter((t) => low.includes(t)).length;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  const from = Math.max(0, best - 1);
  const text = lines.slice(from, from + 8).join('\n');
  return redact(text.length > maxChars ? `${text.slice(0, maxChars)}…` : text);
}
