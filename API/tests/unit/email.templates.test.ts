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
  it('says who invited whom to what, with the action link', () => {
    const link = 'https://auth.example.com/auth/email/link?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';
    const tpl = buildTeamInviteTemplate({
      link,
      organisationName: 'Acme',
      teamName: 'Core Team',
      inviteeName: 'Taylor',
      inviterName: 'Ondra',
      trackingPixelUrl: 'https://auth.example.com/auth/email/team-invite-open/invite-1.gif',
    });
    const escapedLink = link.replaceAll('&', '&amp;');

    expect(tpl.subject).toBe('Ondra invited you to join the Core Team at Acme');
    expect(tpl.text).toContain('Hi Taylor,');
    expect(tpl.text).toContain('Ondra invited you to join the Core Team at Acme.');
    expect(tpl.text).toContain('Accept the invitation:');
    expect(tpl.text).toContain(link);
    expect(tpl.text).toContain('The link works once and expires in 24 hours.');
    expect(tpl.text).toContain('Not expecting this invitation? You can ignore this email.');

    expect(tpl.html).toContain('Join Core Team');
    expect(tpl.html).toContain('Hi Taylor,');
    expect(tpl.html).toContain('Accept invitation');
    expect(tpl.html).toContain('The link works once and expires in 24 hours.');
    expect(tpl.html).toContain('Not expecting this invitation? You can ignore this email.');
    // Nobody asked for an invitation, so the generic "did not request" footer must not appear.
    expect(tpl.html).not.toContain('If you did not request this');
    expect(tpl.html).toContain(`href="${escapedLink}"`);
    expect(tpl.html).toContain('team-invite-open/invite-1.gif');
  });

  it('names the product from the theme logo alt text', () => {
    const tpl = buildTeamInviteTemplate({
      link: 'https://auth.example.com/auth/email/link?token=t',
      organisationName: 'Acme',
      teamName: 'Design',
      inviterName: 'Ondra',
      theme: { logoAlt: 'Nessie' },
    });

    expect(tpl.subject).toBe('Ondra invited you to join the Design team at Acme on Nessie');
    expect(tpl.text).toContain('Ondra invited you to join the Design team at Acme on Nessie.');
    expect(tpl.html).toContain('the Design team at Acme on Nessie.');
  });

  it('does not repeat an organisation whose first team shares its name', () => {
    const tpl = buildTeamInviteTemplate({
      link: 'https://auth.example.com/auth/email/link?token=t',
      organisationName: 'UnlikeOtherAI',
      teamName: 'UnlikeOtherAI',
      inviterName: 'Ondra Rafaj',
      theme: { logoAlt: 'Nessie' },
    });

    expect(tpl.subject).toBe('Ondra Rafaj invited you to join UnlikeOtherAI on Nessie');
    expect(tpl.text).not.toContain('UnlikeOtherAI on UnlikeOtherAI');
  });

  it('names no sender and skips the greeting when neither name is known', () => {
    const tpl = buildTeamInviteTemplate({
      link: 'https://auth.example.com/auth/email/link?token=t',
      organisationName: 'Acme',
      teamName: 'Design',
    });

    expect(tpl.subject).toBe('You’ve been invited to join the Design team at Acme');
    expect(tpl.text.startsWith('You’ve been invited to join the Design team at Acme.')).toBe(true);
    expect(tpl.html).not.toContain('Hi ');
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

describe('buildIntegrationRequestNotificationTemplate', () => {
  it('renders domain, contact email, and admin URL in subject/text/html', () => {
    const tpl = buildIntegrationRequestNotificationTemplate({
      domain: 'api.partner.example',
      contactEmail: 'ops@partner.example',
      adminUrl: 'https://auth.example/admin/integrations?focus=abc123',
    });

    expect(tpl.subject).toBe('New integration request: api.partner.example');
    expect(tpl.text).toContain('api.partner.example');
    expect(tpl.text).toContain('ops@partner.example');
    expect(tpl.text).toContain('https://auth.example/admin/integrations?focus=abc123');

    expect(tpl.html).toContain('New integration request');
    expect(tpl.html).toContain('api.partner.example');
    expect(tpl.html).toContain('ops@partner.example');
    expect(tpl.html).toContain('href="https://auth.example/admin/integrations?focus=abc123"');
  });

  it('escapes attacker-controlled domain and contact email in HTML', () => {
    const tpl = buildIntegrationRequestNotificationTemplate({
      domain: 'evil"><script>alert(1)</script>',
      contactEmail: 'x"@y<script>',
      adminUrl: 'https://auth.example/admin/integrations',
    });

    expect(tpl.html).not.toContain('<script>alert(1)</script>');
    expect(tpl.html).toContain('evil&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(tpl.html).toContain('x&quot;@y&lt;script&gt;');
  });
});
