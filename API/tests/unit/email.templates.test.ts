import { describe, expect, it } from 'vitest';

import {
  buildLoginLinkTemplate,
  buildPasswordResetTemplate,
  buildTwoFaResetTemplate,
  buildVerifyEmailTemplate,
  buildVerifyEmailSetPasswordTemplate,
} from '../../src/services/email.templates.js';

describe('buildVerifyEmailSetPasswordTemplate', () => {
  it('includes subject, text, and html with the provided link', () => {
    const link = 'https://auth.example.com/auth/email/link?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';
    const tpl = buildVerifyEmailSetPasswordTemplate({ link });
    const escapedLink = link.replaceAll('&', '&amp;');

    expect(tpl.subject).toBe('Your sign-in link');
    expect(tpl.text).toContain(link);
    expect(tpl.text).not.toContain('login-link');
    expect(tpl.text).not.toContain('verify-set-password');
    expect(tpl.text).toMatch(/expires in 30 minutes/i);
    expect(tpl.text).toMatch(/ignore this email/i);
    expect(tpl.text).not.toMatch(/set your password/i);

    expect(tpl.html).toContain('Continue signing in');
    expect(tpl.html).toContain('Continue');
    expect(tpl.html).toContain(`href="${escapedLink}"`);
    expect(tpl.html).not.toContain('login-link');
    expect(tpl.html).not.toContain('verify-set-password');
  });

  it('escapes links in HTML so special characters cannot break attributes', () => {
    const link = 'https://example.com/path?x=1&y=2';
    const tpl = buildVerifyEmailSetPasswordTemplate({ link });

    // `&` must be escaped in attributes and body text.
    expect(tpl.html).toContain('href="https://example.com/path?x=1&amp;y=2"');
    expect(tpl.html).toContain('https://example.com/path?x=1&amp;y=2');
    expect(tpl.html).not.toContain('href="https://example.com/path?x=1&y=2"');
  });
});

describe('buildVerifyEmailTemplate', () => {
  it('includes subject, text, and html with the provided link', () => {
    const link = 'https://auth.example.com/auth/email/link?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';
    const tpl = buildVerifyEmailTemplate({ link });
    const escapedLink = link.replaceAll('&', '&amp;');

    expect(tpl.subject).toBe('Verify your email and sign in');
    expect(tpl.text).toContain(link);
    expect(tpl.text).toMatch(/verify your email/i);
    expect(tpl.text).toMatch(/expires in 30 minutes/i);
    expect(tpl.text).toMatch(/ignore this email/i);
    expect(tpl.text).not.toContain('set your password');

    expect(tpl.html).toContain('Verify your email and sign in');
    expect(tpl.html).toContain('Verify email');
    expect(tpl.html).toContain(`href="${escapedLink}"`);
    expect(tpl.html).not.toContain('set your password');
  });

  it('escapes links in HTML so special characters cannot break attributes', () => {
    const link = 'https://example.com/path?x=1&y=2';
    const tpl = buildVerifyEmailTemplate({ link });

    expect(tpl.html).toContain('href="https://example.com/path?x=1&amp;y=2"');
    expect(tpl.html).toContain('https://example.com/path?x=1&amp;y=2');
    expect(tpl.html).not.toContain('href="https://example.com/path?x=1&y=2"');
  });
});

describe('buildPasswordResetTemplate', () => {
  it('includes subject, text, and html with the provided link', () => {
    const link = 'https://auth.example.com/auth/email/reset-password?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';
    const tpl = buildPasswordResetTemplate({ link });
    const escapedLink = link.replaceAll('&', '&amp;');

    expect(tpl.subject).toBe('Reset your password');
    expect(tpl.text).toContain(link);
    expect(tpl.text).toMatch(/expires in 30 minutes/i);
    expect(tpl.text).toMatch(/ignore this email/i);
    expect(tpl.text).toMatch(/if you requested a password reset/i);

    expect(tpl.html).toContain('Reset your password');
    expect(tpl.html).toContain('Reset password');
    expect(tpl.html).toContain(`href="${escapedLink}"`);
  });

  it('escapes links in HTML so special characters cannot break attributes', () => {
    const link = 'https://example.com/path?x=1&y=2';
    const tpl = buildPasswordResetTemplate({ link });

    // `&` must be escaped in attributes and body text.
    expect(tpl.html).toContain('href="https://example.com/path?x=1&amp;y=2"');
    expect(tpl.html).toContain('https://example.com/path?x=1&amp;y=2');
    expect(tpl.html).not.toContain('href="https://example.com/path?x=1&y=2"');
  });
});

describe('buildLoginLinkTemplate', () => {
  it('includes subject, text, and html with the provided link', () => {
    const link = 'https://auth.example.com/auth/email/link?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';
    const tpl = buildLoginLinkTemplate({ link });
    const escapedLink = link.replaceAll('&', '&amp;');

    expect(tpl.subject).toBe('Your sign-in link');
    expect(tpl.text).toContain(link);
    expect(tpl.text).not.toContain('login-link');
    expect(tpl.text).not.toContain('verify-set-password');
    expect(tpl.text).toMatch(/expires in 30 minutes/i);
    expect(tpl.text).toMatch(/ignore this email/i);

    expect(tpl.html).toContain('Continue signing in');
    expect(tpl.html).toContain('Continue');
    expect(tpl.html).toContain(`href="${escapedLink}"`);
    expect(tpl.html).not.toContain('login-link');
    expect(tpl.html).not.toContain('verify-set-password');
  });

  it('escapes links in HTML so special characters cannot break attributes', () => {
    const link = 'https://example.com/path?x=1&y=2';
    const tpl = buildLoginLinkTemplate({ link });

    // `&` must be escaped in attributes and body text.
    expect(tpl.html).toContain('href="https://example.com/path?x=1&amp;y=2"');
    expect(tpl.html).toContain('https://example.com/path?x=1&amp;y=2');
    expect(tpl.html).not.toContain('href="https://example.com/path?x=1&y=2"');
  });
});

describe('buildTwoFaResetTemplate', () => {
  it('includes subject, text, and html with the provided link', () => {
    const link = 'https://auth.example.com/auth/email/twofa-reset?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';
    const tpl = buildTwoFaResetTemplate({ link });
    const escapedLink = link.replaceAll('&', '&amp;');

    expect(tpl.subject).toBe('Reset two-factor authentication');
    expect(tpl.text).toContain(link);
    expect(tpl.text).toMatch(/expires in 30 minutes/i);
    expect(tpl.text).toMatch(/ignore this email/i);
    expect(tpl.text).toMatch(/if you requested to reset two-factor authentication/i);

    expect(tpl.html).toContain('Reset two-factor authentication');
    expect(tpl.html).toContain(`href="${escapedLink}"`);
  });

  it('escapes links in HTML so special characters cannot break attributes', () => {
    const link = 'https://example.com/path?x=1&y=2';
    const tpl = buildTwoFaResetTemplate({ link });

    // `&` must be escaped in attributes and body text.
    expect(tpl.html).toContain('href="https://example.com/path?x=1&amp;y=2"');
    expect(tpl.html).toContain('https://example.com/path?x=1&amp;y=2');
    expect(tpl.html).not.toContain('href="https://example.com/path?x=1&y=2"');
  });
});
