export const DEFAULT_MAX_CHARS = 8000;
const CHARS_PER_TOKEN = 4;

export const budgetToChars = (tokenBudget?: number, maxChars?: number): number =>
  maxChars ?? (tokenBudget ? tokenBudget * CHARS_PER_TOKEN : DEFAULT_MAX_CHARS);

/**
 * Keeps items while the serialized size fits the budget. A too-large item first loses its
 * `snippet`; if it still does not fit, the list is cut.
 */
export function applyBudget<T extends { snippet?: string }>(items: T[], maxChars: number): { items: T[]; truncated: boolean } {
  const kept: T[] = [];
  let used = 2;
  for (const item of items) {
    let candidate = item;
    let size = JSON.stringify(candidate).length + 1;
    if (used + size > maxChars && candidate.snippet) {
      candidate = { ...candidate, snippet: undefined };
      size = JSON.stringify(candidate).length + 1;
    }
    if (used + size > maxChars) return { items: kept, truncated: true };
    kept.push(candidate);
    used += size;
  }
  return { items: kept, truncated: false };
}
