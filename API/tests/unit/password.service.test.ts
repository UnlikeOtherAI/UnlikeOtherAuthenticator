import { describe, expect, it } from 'vitest';

import {
  assertPasswordValid,
  hashPassword,
  isPasswordValid,
  verifyPassword,
} from '../../src/services/password.service.js';

describe('password.service', () => {
  it('accepts valid passwords meeting the policy', () => {
    expect(isPasswordValid('Abcdef1-')).toBe(true); // '-' allowed
    expect(isPasswordValid('Zz9!aaaa')).toBe(true);
  });

  it('rejects passwords shorter than 8 characters', () => {
    expect(isPasswordValid('Aa1-aaa')).toBe(false);
    expect(() => assertPasswordValid('Aa1-aaa')).toThrow();
  });

  it('rejects passwords missing an uppercase letter', () => {
    expect(isPasswordValid('abcdef1-')).toBe(false);
  });

  it('rejects passwords missing a lowercase letter', () => {
    expect(isPasswordValid('ABCDEF1-')).toBe(false);
  });

  it('rejects passwords missing a number', () => {
    expect(isPasswordValid('Abcdefg-')).toBe(false);
  });

  it('rejects passwords missing a special character', () => {
    expect(isPasswordValid('Abcdef12')).toBe(false);
  });

  it('does not treat whitespace as a special character', () => {
    expect(isPasswordValid('Abcdef1 ')).toBe(false);
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
