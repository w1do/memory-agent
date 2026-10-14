const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED_TOKEN]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  // quoted values: any content
  [/((?:api[_-]?key|secret|token|password|passwd|pwd|authorization|private[_-]?key)["']?\s*[:=]\s*)(["'])[^"'\n]{6,}\2/gi, '$1$2[REDACTED]$2'],
  // unquoted values: must contain a digit or symbol (so `password: string` type annotations stay intact)
  [/((?:api[_-]?key|secret|token|password|passwd|pwd|authorization|private[_-]?key)["']?\s*[:=]\s*)(?=[^\s"',;]*[\d_\-.\/+=])[^\s"',;]{6,}/gi, '$1[REDACTED]'],
];

/** Masks well-known secret shapes and `key = value` pairs with sensitive names. */
export function redact(text: string): string {
  return PATTERNS.reduce((acc, [re, to]) => acc.replace(re, to), text);
}
