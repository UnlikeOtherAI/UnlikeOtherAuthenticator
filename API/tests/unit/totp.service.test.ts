import { describe, expect, it } from 'vitest';

import { generateTotpSecret } from '../../src/services/totp.service.js';

describe('totp.service', () => {
  it('generates a base32 secret compatible with authenticator apps', () => {
    const secret = generateTotpSecret();

    // 20 bytes -> ceil(160/5) = 32 base32 chars.
    expect(secret).toHaveLength(32);
    expect(secret).toMatch(/^[A-Z2-7]+$/);
  });

  it('generates different secrets across calls', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();

    expect(a).not.toBe(b);
  });
});

