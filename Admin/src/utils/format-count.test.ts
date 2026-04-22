import { describe, expect, it } from 'vitest';

import { formatCompactCount } from './format-count';

describe('formatCompactCount', () => {
  it('keeps small counts readable', () => {
    expect(formatCompactCount(12)).toBe('12');
    expect(formatCompactCount(999)).toBe('999');
  });

  it('compacts large counts for sidebar badges', () => {
    expect(formatCompactCount(1_247)).toBe('1.2k');
    expect(formatCompactCount(12_500)).toBe('12.5k');
    expect(formatCompactCount(1_200_000)).toBe('1.2m');
  });
});
