import { describe, expect, it } from 'vitest';

import {
  assertPasswordValid,
  hashPassword,
  isPasswordValid,
  verifyPassword,
} from '../../src/services/password.service.js';

describe('password.service', () => {
  // Decision 2026-06-18 (HUGO-147): length is the only enforced rule; character classes
  // (uppercase / lowercase / number / special) are encouraged but NOT required.
  it('accepts any password of at least 8 characters', () => {
    expect(isPasswordValid('Abcdef1-')).toBe(true);
    expect(isPasswordValid('Zz9!aaaa')).toBe(true);
    // Regression (HUGO-147): a strong alphanumeric-only password must be accepted.
    expect(isPasswordValid('zMN8iBS9Lkzib5J')).toBe(true);
    expect(isPasswordValid('aaaaaaaa')).toBe(true);
  });

  it('rejects passwords shorter than 8 characters', () => {
    expect(isPasswordValid('Aa1-aaa')).toBe(false);
    expect(() => assertPasswordValid('Aa1-aaa')).toThrow();
  });

  it('does not require a special character', () => {
    expect(isPasswordValid('Abcdef12')).toBe(true);
  });

  it('does not require mixed case or numbers', () => {
    expect(isPasswordValid('abcdefgh')).toBe(true);
    expect(isPasswordValid('ABCDEFGH')).toBe(true);
  });

  it('hashes and verifies passwords with argon2id', async () => {
    const password = 'Abcdef1-';
    const hash = await hashPassword(password);

    expect(hash).toContain('$argon2id$');
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword('Wrongpass1-', hash)).resolves.toBe(false);
  });

  it('rejects hashing when password violates the policy', async () => {
    await expect(hashPassword('Aa1-aaa')).rejects.toThrow();
  });

  it('fails closed when hash is invalid/corrupt', async () => {
    await expect(verifyPassword('Abcdef1-', 'not-a-hash')).resolves.toBe(false);
  });
});
