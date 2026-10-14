import { createHash } from 'node:crypto';

export const sha256 = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

/** Stable short id derived from arbitrary parts. */
export const stableId = (...parts: string[]): string =>
  sha256(parts.join('\u0000')).slice(0, 32);

/** Qdrant requires UUID or unsigned int point ids; derive a UUID from a stable id. */
export const toUuid = (id: string): string => {
  const h = sha256(id).slice(0, 32).split('');
  h[12] = '5';
  h[16] = '89ab'[parseInt(h[16], 16) % 4];
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
};
