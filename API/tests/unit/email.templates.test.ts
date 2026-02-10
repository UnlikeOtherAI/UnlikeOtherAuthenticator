import { describe, expect, it } from 'vitest';

import { buildVerifyEmailSetPasswordTemplate } from '../../src/services/email.templates.js';

describe('buildVerifyEmailSetPasswordTemplate', () => {
  it('includes subject, text, and html with the provided link', () => {
    const link = 'https://auth.example.com/auth/email/verify-set-password?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';
    const tpl = buildVerifyEmailSetPasswordTemplate({ link });
    const escapedLink = link.replaceAll('&', '&amp;');

    expect(tpl.subject).toBe('Verify your email');
    expect(tpl.text).toContain(link);
    expect(tpl.text).toMatch(/expires in 30 minutes/i);
    expect(tpl.text).toMatch(/ignore this email/i);

    expect(tpl.html).toContain('Confirm your email address');
    expect(tpl.html).toContain('Verify email');
    expect(tpl.html).toContain(`href="${escapedLink}"`);
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
