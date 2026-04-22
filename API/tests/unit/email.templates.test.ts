import { describe, expect, it } from 'vitest';

import {
  buildAccessRequestNotificationTemplate,
  buildAccountExistsTemplate,
  buildIntegrationRequestNotificationTemplate,
  buildRegistrationLinkTemplate,
  buildLoginLinkTemplate,
  buildPasswordResetTemplate,
  buildTeamInviteTemplate,
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
    expect(tpl.text).toContain('access your account or finish signing up');
    expect(tpl.text).not.toContain('login-link');
    expect(tpl.text).not.toContain('verify-set-password');
    expect(tpl.text).toMatch(/expires in 30 minutes/i);
    expect(tpl.text).toMatch(/ignore this email/i);
    expect(tpl.text).not.toMatch(/set your password/i);

    expect(tpl.html).toContain('Continue to your account');
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

    expect(tpl.subject).toBe('Your sign-in link');
    expect(tpl.text).toContain(link);
    expect(tpl.text).toContain('access your account or finish signing up');
    expect(tpl.text).toMatch(/expires in 30 minutes/i);
    expect(tpl.text).toMatch(/ignore this email/i);
    expect(tpl.text).not.toContain('set your password');

    expect(tpl.html).toContain('Continue to your account');
    expect(tpl.html).toContain('Continue');
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
    expect(tpl.text).toContain('access your account or finish signing up');
    expect(tpl.text).not.toContain('login-link');
    expect(tpl.text).not.toContain('verify-set-password');
    expect(tpl.text).toMatch(/expires in 30 minutes/i);
    expect(tpl.text).toMatch(/ignore this email/i);

    expect(tpl.html).toContain('Continue to your account');
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

describe('registration link template aliases', () => {
  it('uses one neutral template for new-user, existing-user, and login-link emails', () => {
    const link = 'https://auth.example.com/auth/email/link?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';
    const neutral = buildRegistrationLinkTemplate({ link });

    expect(buildVerifyEmailSetPasswordTemplate({ link })).toEqual(neutral);
    expect(buildVerifyEmailTemplate({ link })).toEqual(neutral);
    expect(buildLoginLinkTemplate({ link })).toEqual(neutral);
    expect(buildAccountExistsTemplate({ link })).toEqual(neutral);
    expect(neutral.subject).toBe('Your sign-in link');
    expect(neutral.text).not.toMatch(/already have an account|verify your email/i);
    expect(neutral.html).not.toMatch(/already have an account|reset password/i);
  });
});

describe('buildTeamInviteTemplate', () => {
  it('includes the invite context and action link', () => {
    const link = 'https://auth.example.com/auth/email/link?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';
    const tpl = buildTeamInviteTemplate({
      link,
      organisationName: 'Acme',
      teamName: 'Core Team',
      inviteeName: 'Taylor',
      trackingPixelUrl: 'https://auth.example.com/auth/email/team-invite-open/invite-1.gif',
    });
    const escapedLink = link.replaceAll('&', '&amp;');

    expect(tpl.subject).toBe('You have been invited to join Core Team');
    expect(tpl.text).toContain('Taylor, you have been invited to join the Core Team team on Acme.');
    expect(tpl.text).toContain(link);
    expect(tpl.text).toMatch(/accept the invitation/i);

    expect(tpl.html).toContain('Join Core Team');
    expect(tpl.html).toContain('Accept invitation');
    expect(tpl.html).toContain(`href="${escapedLink}"`);
    expect(tpl.html).toContain('team-invite-open/invite-1.gif');
  });
});

describe('buildAccessRequestNotificationTemplate', () => {
  it('includes requester context and the admin review link without token-expiry copy', () => {
    const reviewUrl = 'https://admin.example.com/team-access?request=123&team=core';
    const tpl = buildAccessRequestNotificationTemplate({
      reviewUrl,
      requesterEmail: 'alex@example.com',
      requesterName: 'Alex Example',
      organisationName: 'Acme',
      teamName: 'Core Team',
    });

    expect(tpl.subject).toBe('Alex Example <alex@example.com> requested access to Core Team');
    expect(tpl.text).toContain('Access request received');
    expect(tpl.text).toContain(reviewUrl);
    expect(tpl.text).not.toMatch(/expires in 30 minutes/i);
    expect(tpl.html).toContain('Review request');
    expect(tpl.html).toContain('Alex Example &lt;alex@example.com&gt;');
    expect(tpl.html).toContain('href="https://admin.example.com/team-access?request=123&amp;team=core"');
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
