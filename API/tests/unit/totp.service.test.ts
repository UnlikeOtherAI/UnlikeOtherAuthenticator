import { describe, expect, it } from 'vitest';

import { buildTotpOtpAuthUri, generateTotpSecret } from '../../src/services/totp.service.js';

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

  it('builds an otpauth:// URI for enrollment', () => {
    const uri = buildTotpOtpAuthUri({
      secret: 'JBSWY3DPEHPK3PXP',
      issuer: 'My App',
      accountName: 'user@example.com',
    });

    const u = new URL(uri);
    expect(u.protocol).toBe('otpauth:');
    expect(u.hostname).toBe('totp');
    expect(u.pathname).toBe('/My%20App:user%40example.com');
    expect(u.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(u.searchParams.get('issuer')).toBe('My App');
    expect(u.searchParams.get('algorithm')).toBe('SHA1');
    expect(u.searchParams.get('digits')).toBe('6');
    expect(u.searchParams.get('period')).toBe('30');
  });

  it('rejects invalid secrets when building an otpauth:// URI', () => {
    expect(() =>
      buildTotpOtpAuthUri({ secret: '', issuer: 'My App', accountName: 'user@example.com' }),
    ).toThrow();

    // Lowercase base32 should be rejected to avoid ambiguous inputs.
    expect(() =>
      buildTotpOtpAuthUri({
        secret: 'jbswy3dpehpk3pxp',
        issuer: 'My App',
        accountName: 'user@example.com',
      }),
    ).toThrow();
  });
});
