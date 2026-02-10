import { describe, expect, it } from 'vitest';

import {
  buildTotpOtpAuthUri,
  generateTotpSecret,
  renderTotpQrCodeDataUrl,
  verifyTotpCode,
} from '../../src/services/totp.service.js';

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

  it('renders a scannable QR code data URL for an otpauth:// URI', async () => {
    const uri = buildTotpOtpAuthUri({
      secret: 'JBSWY3DPEHPK3PXP',
      issuer: 'My App',
      accountName: 'user@example.com',
    });

    const dataUrl = await renderTotpQrCodeDataUrl({ otpAuthUri: uri });
    expect(dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);

    const b64 = dataUrl.slice('data:image/svg+xml;base64,'.length);
    const svg = Buffer.from(b64, 'base64').toString('utf8');
    expect(svg).toContain('<svg');
  });

  it('verifies RFC 6238 SHA1 test vectors (8 digits)', () => {
    // RFC 6238 Appendix B uses secret "12345678901234567890" (ASCII),
    // which base32-encodes to:
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

    expect(
      verifyTotpCode({
        secret,
        code: '94287082',
        digits: 8,
        algorithm: 'SHA1',
        period: 30,
        now: new Date(59_000),
        window: 0,
      }),
    ).toBe(true);

    expect(
      verifyTotpCode({
        secret,
        code: '07081804',
        digits: 8,
        algorithm: 'SHA1',
        period: 30,
        now: new Date(1_111_111_109_000),
        window: 0,
      }),
    ).toBe(true);

    expect(
      verifyTotpCode({
        secret,
        code: '00000000',
        digits: 8,
        algorithm: 'SHA1',
        period: 30,
        now: new Date(59_000),
        window: 0,
      }),
    ).toBe(false);
  });

  it('verifies 6-digit codes with a small time-skew window', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

    // At t=59s, the 6-digit code is 287082 (94287082 mod 1e6).
    expect(
      verifyTotpCode({
        secret,
        code: '287082',
        digits: 6,
        algorithm: 'SHA1',
        period: 30,
        now: new Date(59_000),
        window: 0,
      }),
    ).toBe(true);

    // With window=1, accept a code from the previous 30s step.
    expect(
      verifyTotpCode({
        secret,
        code: '287082',
        digits: 6,
        algorithm: 'SHA1',
        period: 30,
        now: new Date(89_000),
        window: 1,
      }),
    ).toBe(true);

    expect(
      verifyTotpCode({
        secret,
        code: '287082',
        digits: 6,
        algorithm: 'SHA1',
        period: 30,
        now: new Date(89_000),
        window: 0,
      }),
    ).toBe(false);
  });
});
