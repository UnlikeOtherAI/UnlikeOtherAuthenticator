import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { sanitizeConfigJwtForHandshakeLog } from '../config-verifier.js';

const sharedSecret = 'test-shared-secret-with-enough-length';

describe('config verifier handshake log JWT redaction', () => {
  it('redacts sensitive JWT claims recursively', async () => {
    const jwt = await new SignJWT({
      domain: 'app.example.com',
      redirect_urls: ['https://app.example.com/callback?token=redirect-token#secret-fragment'],
      registration_redirect_urls: ['https://app.example.com/register?code=registration-code'],
      client_secret: 'secret-value',
      access_token: 'access-token-value',
      custom_debug: 'unrecognized-value',
      ui_theme: {
        colors: {
          bg: '#ffffff',
          trace_id: 'trace-value',
        },
        apiKey: 'api-key-value',
        refresh_token: 'refresh-token-value',
        safe: 'safe-value',
        logo: {
          url: 'https://app.example.com/logo.png?signature=logo-signature',
          style: { letterSpacing: '1px' },
        },
        providers: [{ password: 'provider-password', label: 'email' }],
      },
      access_requests: {
        enabled: true,
        admin_review_url: 'https://app.example.com/admin/review?token=review-token',
      },
      registration_domain_mapping: [
        { email_domain: 'example.com', org_id: 'org_1', team_id: 'team_1', note: 'private-note' },
      ],
    })
      .setProtectedHeader({ alg: 'HS256', kid: 'kid-1' })
      .sign(new TextEncoder().encode(sharedSecret));

    const result = sanitizeConfigJwtForHandshakeLog(jwt);

    expect(result.payload).toMatchObject({
      domain: 'app.example.com',
      redirect_urls: ['https://app.example.com/callback'],
      registration_redirect_urls: ['https://app.example.com/register'],
      client_secret: '[redacted]',
      access_token: '[redacted]',
      custom_debug: '[redacted_unrecognized]',
      ui_theme: {
        colors: {
          bg: '#ffffff',
          trace_id: '[redacted_unrecognized]',
        },
        apiKey: '[redacted]',
        refresh_token: '[redacted]',
        safe: '[redacted_unrecognized]',
        logo: {
          url: 'https://app.example.com/logo.png',
          style: { letterSpacing: '[redacted_unrecognized]' },
        },
        providers: '[redacted_unrecognized]',
      },
      access_requests: {
        enabled: true,
        admin_review_url: 'https://app.example.com/admin/review',
      },
      registration_domain_mapping: [
        { email_domain: 'example.com', org_id: 'org_1', team_id: 'team_1', note: '[redacted_unrecognized]' },
      ],
    });
    expect(result.redactions).toEqual(
      expect.arrayContaining([
        'payload.redirect_urls[0]',
        'payload.registration_redirect_urls[0]',
        'payload.client_secret',
        'payload.access_token',
        'payload.custom_debug',
        'payload.ui_theme.colors.trace_id',
        'payload.ui_theme.apiKey',
        'payload.ui_theme.refresh_token',
        'payload.ui_theme.safe',
        'payload.ui_theme.logo.style.letterSpacing',
        'payload.ui_theme.logo.url',
        'payload.ui_theme.providers',
        'payload.access_requests.admin_review_url',
        'payload.registration_domain_mapping[0].note',
      ]),
    );
    expect(JSON.stringify(result.payload)).not.toContain('secret-value');
    expect(JSON.stringify(result.payload)).not.toContain('access-token-value');
    expect(JSON.stringify(result.payload)).not.toContain('unrecognized-value');
    expect(JSON.stringify(result.payload)).not.toContain('api-key-value');
    expect(JSON.stringify(result.payload)).not.toContain('refresh-token-value');
    expect(JSON.stringify(result.payload)).not.toContain('safe-value');
    expect(JSON.stringify(result.payload)).not.toContain('provider-password');
    expect(JSON.stringify(result.payload)).not.toContain('private-note');
    expect(JSON.stringify(result.payload)).not.toContain('redirect-token');
    expect(JSON.stringify(result.payload)).not.toContain('registration-code');
    expect(JSON.stringify(result.payload)).not.toContain('logo-signature');
    expect(JSON.stringify(result.payload)).not.toContain('review-token');
  });

  it('does not persist undecodable JWT contents', () => {
    const result = sanitizeConfigJwtForHandshakeLog('not-a-jwt');

    expect(result.header).toEqual({});
    expect(result.payload).toEqual({});
    expect(result.redactions).toContain('undecodable_jwt');
  });
});
