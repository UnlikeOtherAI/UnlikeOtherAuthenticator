import { describe, expect, it } from 'vitest';

import { codePlaceholder, sanitizeCodeValue } from './code-input.js';

describe('sanitizeCodeValue', () => {
  it('strips non-digit characters', () => {
    expect(sanitizeCodeValue('a1b2c3', 6)).toBe('123');
  });

  it('caps the result to the given length (paste of a longer value)', () => {
    expect(sanitizeCodeValue('123456789', 6)).toBe('123456');
  });

  it('passes through a value already within bounds', () => {
    expect(sanitizeCodeValue('123', 6)).toBe('123');
  });

  it('supports an 8-digit cap for backup-style codes', () => {
    expect(sanitizeCodeValue('12345678900', 8)).toBe('12345678');
  });

  it('returns an empty string when nothing numeric is pasted', () => {
    expect(sanitizeCodeValue('abcdef', 6)).toBe('');
  });
});

describe('codePlaceholder', () => {
  it('builds a sequential 6-digit placeholder', () => {
    expect(codePlaceholder(6)).toBe('123456');
  });

  it('builds a sequential 8-digit placeholder', () => {
    expect(codePlaceholder(8)).toBe('12345678');
  });
});
