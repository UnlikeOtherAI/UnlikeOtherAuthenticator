import { SignJWT } from 'jose';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { sanitizeConfigJwtForHandshakeLog } from '../config-verifier.js';
import {
  buildHandshakeRequestJson,
  configFetchFailureDetails,
} from '../../services/handshake-log-context.service.js';

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

  it('captures auth request context without leaking query secrets', () => {
    const redactions: string[] = [];
    const request = {
      id: 'req-1',
      method: 'GET',
      url: '/auth?config_url=https%3A%2F%2Fclient.example.com%2Fconfig%3Ftoken%3Dsecret&redirect_url=https%3A%2F%2Fclient.example.com%2Fcallback%3Fstate%3Dsecret-state&code=oauth-code&code_challenge=pkce-challenge&code_challenge_method=S256',
      raw: {
        url: '/auth?config_url=https%3A%2F%2Fclient.example.com%2Fconfig%3Ftoken%3Dsecret&redirect_url=https%3A%2F%2Fclient.example.com%2Fcallback%3Fstate%3Dsecret-state&code=oauth-code&code_challenge=pkce-challenge&code_challenge_method=S256',
      },
      ip: '203.0.113.10',
      headers: {
        host: 'authentication.example.com',
        referer: 'https://app.example.com/start?token=secret',
        'user-agent': 'test-agent',
        'x-forwarded-for': '203.0.113.10',
        'x-cloud-trace-context': 'trace-id/span;o=1',
      },
    } as unknown as FastifyRequest;

    const result = buildHandshakeRequestJson({
      request,
      configUrl: 'https://client.example.com/config?token=secret',
      redactions,
      configFetchRequest: {
        method: 'GET',
        config_url: 'https://client.example.com/config',
      },
    });

    expect(result).toMatchObject({
      auth_request: {
        id: 'req-1',
        method: 'GET',
        path: '/auth',
        query: {
          config_url: 'https://client.example.com/config',
          redirect_url: 'https://client.example.com/callback',
          code: '[redacted]',
          code_challenge: 'pkce-challenge',
          code_challenge_method: 'S256',
        },
        ip: '203.0.113.10',
        headers: {
          host: 'authentication.example.com',
          referer: 'https://app.example.com/start',
          user_agent: 'test-agent',
          x_cloud_trace_context: 'trace-id/span;o=1',
        },
      },
      config_fetch_request: {
        method: 'GET',
        config_url: 'https://client.example.com/config',
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('oauth-code');
    expect(redactions).toEqual(
      expect.arrayContaining([
        'request.auth_request.query.config_url',
        'request.auth_request.query.redirect_url',
        'request.auth_request.query.code',
        'request.auth_request.headers.referer',
      ]),
    );
  });

  it('turns config fetch diagnostics into useful details', () => {
    const details = configFetchFailureDetails('https://client.example.com/config', {
      request: { method: 'GET', config_url: 'https://client.example.com/config' },
      response: {
        reason: 'CONFIG_URL_HTTP_STATUS_REJECTED',
        final_url: 'https://client.example.com/config',
        status: 404,
        status_text: 'Not Found',
        content_type: 'text/html',
      },
      redactions: [],
    });

    expect(details).toEqual(
      expect.arrayContaining([
        'Config fetch attempted: GET https://client.example.com/config',
        'Fetch reason: CONFIG_URL_HTTP_STATUS_REJECTED.',
        'Config endpoint HTTP status: 404 Not Found.',
        'Response content type: text/html.',
      ]),
    );
  });
});
