import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../../src/project/classify.js';
import { DEFAULT_EXCLUDES, ExcludeMatcher } from '../../src/security/policy.js';
import { isIndexable } from '../../src/project/scan.js';

const matcher = new ExcludeMatcher(DEFAULT_EXCLUDES);

describe('astro sources', () => {
  it('detects .astro files as astro language', () => {
    expect(detectLanguage('src/pages/index.astro')).toBe('astro');
    expect(detectLanguage('src/components/Card.astro')).toBe('astro');
  });

  it('keeps src/*.astro indexable without excluding them as tool folders', () => {
    expect(isIndexable(matcher, 'src/pages/index.astro', 100, 512 * 1024)).not.toBeNull();
  });
});
