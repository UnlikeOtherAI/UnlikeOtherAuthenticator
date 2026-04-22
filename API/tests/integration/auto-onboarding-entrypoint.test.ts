import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';

import { createApp } from '../../src/app.js';

const integrationRequestMocks = vi.hoisted(() => ({
  findOpenIntegrationRequest: vi.fn(),
  upsertPendingIntegrationRequest: vi.fn(),
}));

vi.mock('../../src/services/integration-request.service.js', () => integrationRequestMocks);

vi.mock('../../src/db/prisma.js', () => ({
  getPrisma: vi.fn(() => ({})),
  connectPrisma: vi.fn(async () => {}),
  disconnectPrisma: vi.fn(async () => {}),
}));

type KeyFixture = {
  privateKey: KeyLike;
  publicJwk: Record<string, unknown>;
};

async function makeKey(kid: string): Promise<KeyFixture> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  const publicJwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwk: { ...publicJwk, kid, alg: 'RS256', use: 'sig' },
  };
}

async function signJwt(
  privateKey: KeyLike,
  kid: string,
  payload: Record<string, unknown>,
): Promise<string> {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .setAudience(process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service')
    .sign(privateKey);
}

function uiTheme(): Record<string, unknown> {
  return {
    colors: {
      bg: '#f8fafc',
      surface: '#ffffff',
      text: '#0f172a',
      muted: '#475569',
      primary: '#2563eb',
      primary_text: '#ffffff',
      border: '#e2e8f0',
      danger: '#dc2626',
      danger_text: '#ffffff',
    },
    radii: { card: '16px', button: '12px', input: '12px' },
    density: 'comfortable',
    typography: { font_family: 'sans', base_text_size: 'md' },
    button: { style: 'solid' },
    card: { style: 'bordered' },
    logo: { url: '', alt: 'Logo' },
  };
}

describe('GET /auth — auto-onboarding', () => {
  beforeEach(() => {
    integrationRequestMocks.findOpenIntegrationRequest.mockReset().mockResolvedValue(null);
    integrationRequestMocks.upsertPendingIntegrationRequest
      .mockReset()
      .mockResolvedValue({ kind: 'created', row: { id: 'req-1' } });
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ?? 'postgres://uoa:test@127.0.0.1:5432/uoa?schema=public';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the integration pending page when a new partner opts into auto-onboarding', async () => {
    const kid = 'partner-2026-04-a';
    const partner = await makeKey(kid);
    const configPayload = {
      domain: 'partner.example.com',
      redirect_urls: ['https://partner.example.com/oauth/callback'],
      enabled_auth_methods: ['email_password'],
      ui_theme: uiTheme(),
      language_config: 'en',
      jwks_url: 'https://partner.example.com/.well-known/jwks.json',
      contact_email: 'ops@partner.example.com',
    };
    const configJwt = await signJwt(partner.privateKey, kid, configPayload);

    const configUrl = 'https://partner.example.com/config';
    const jwksUrl = configPayload.jwks_url;

    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === configUrl) return new Response(configJwt, { status: 200 });
      if (url === jwksUrl) {
        return new Response(JSON.stringify({ keys: [partner.publicJwk] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/auth?config_url=${encodeURIComponent(configUrl)}`,
        headers: { accept: 'text/html' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('Integration pending review');
      expect(res.body).toContain('ops@partner.example.com');
      expect(res.body).toContain('partner.example.com');

      expect(integrationRequestMocks.upsertPendingIntegrationRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'partner.example.com',
          kid,
          contactEmail: 'ops@partner.example.com',
          jwksUrl,
          configUrl,
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('renders the declined page when a prior DECLINED row exists for the domain', async () => {
    const kid = 'partner-2026-04-b';
    const partner = await makeKey(kid);
    integrationRequestMocks.findOpenIntegrationRequest.mockResolvedValue({
      id: 'req-declined',
      domain: 'partner.example.com',
      status: 'DECLINED',
    });

    const configPayload = {
      domain: 'partner.example.com',
      redirect_urls: ['https://partner.example.com/oauth/callback'],
      enabled_auth_methods: ['email_password'],
      ui_theme: uiTheme(),
      language_config: 'en',
      jwks_url: 'https://partner.example.com/.well-known/jwks.json',
      contact_email: 'ops@partner.example.com',
    };
    const configJwt = await signJwt(partner.privateKey, kid, configPayload);

    const configUrl = 'https://partner.example.com/config';
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === configUrl) return new Response(configJwt, { status: 200 });
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/auth?config_url=${encodeURIComponent(configUrl)}`,
        headers: { accept: 'text/html' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('Integration declined');
      expect(integrationRequestMocks.upsertPendingIntegrationRequest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
