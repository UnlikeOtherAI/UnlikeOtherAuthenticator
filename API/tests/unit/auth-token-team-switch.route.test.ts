import type { ClientConfig } from '../../src/services/config.service.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/utils/errors.js';
import { testUiTheme } from '../helpers/test-config.js';

const exchangeTeamSwitchForTokensMock = vi.fn();
let currentConfig: ClientConfig;
let attachAuthenticatedClient = true;

vi.mock('../../src/middleware/config-verifier.js', () => ({
  configVerifier: async (request: {
    query?: { config_url?: string };
    configUrl?: string;
    config?: ClientConfig;
  }): Promise<void> => {
    request.configUrl = request.query?.config_url;
    request.config = currentConfig;
  },
}));

vi.mock('../../src/middleware/domain-hash-auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/middleware/domain-hash-auth.js')>(
    '../../src/middleware/domain-hash-auth.js',
  );
  return {
    ...actual,
    requireDomainHashAuth: async (request: {
      domainAuthClientId?: string;
      domainAuthClientDomainId?: string;
    }): Promise<void> => {
      if (!attachAuthenticatedClient) return;
      request.domainAuthClientId = 'a'.repeat(64);
      request.domainAuthClientDomainId = 'client-domain-nessie';
    },
  };
});

vi.mock('../../src/services/team-switch-token.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/team-switch-token.service.js')
  >('../../src/services/team-switch-token.service.js');
  return {
    ...actual,
    exchangeTeamSwitchForTokens: (...args: unknown[]) =>
      exchangeTeamSwitchForTokensMock(...args),
  };
});

function config(): ClientConfig {
  return {
    domain: 'api.nessie.works',
    redirect_urls: ['https://app.nessie.works/auth/callback'],
    enabled_auth_methods: ['google'],
    ui_theme: testUiTheme(),
    language_config: 'en',
    org_features: { enabled: true },
  } as unknown as ClientConfig;
}

const grantType = 'urn:unlikeotherai:params:oauth:grant-type:team-switch';
const configUrl = 'https://api.nessie.works/auth/config';
let remoteOctet = 1;

function nextRemoteAddress(): string {
  return `198.51.100.${remoteOctet++}`;
}

describe('POST /auth/token team-switch grant', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalDebugEnabled = process.env.DEBUG_ENABLED;

  beforeEach(() => {
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    process.env.DEBUG_ENABLED = 'false';
    currentConfig = config();
    attachAuthenticatedClient = true;
    exchangeTeamSwitchForTokensMock.mockResolvedValue({
      accessToken: 'switched-access-token',
      expiresInSeconds: 900,
      refreshToken: 'switched-refresh-token',
      refreshTokenExpiresInSeconds: 86_400,
    });
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalDebugEnabled === undefined) Reflect.deleteProperty(process.env, 'DEBUG_ENABLED');
    else process.env.DEBUG_ENABLED = originalDebugEnabled;
    vi.clearAllMocks();
  });

  async function createTestApp() {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();
    return app;
  }

  function requestPayload(overrides?: Record<string, unknown>) {
    return {
      grant_type: grantType,
      refresh_token: 'source-refresh-token',
      organization_id: 'org-target',
      team_id: 'team-target',
      ...overrides,
    };
  }

  it('dispatches the exact target and returns the standard pair without firstLogin', async () => {
    const app = await createTestApp();
    try {
      const response = await app.inject({
        method: 'POST',
        remoteAddress: nextRemoteAddress(),
        url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
        headers: { authorization: `Bearer ${'a'.repeat(64)}` },
        payload: requestPayload(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(response.json()).toEqual({
        access_token: 'switched-access-token',
        expires_in: 900,
        refresh_token: 'switched-refresh-token',
        refresh_token_expires_in: 86_400,
        token_type: 'Bearer',
      });
      expect(exchangeTeamSwitchForTokensMock).toHaveBeenCalledWith(
        {
          authenticatedClientDomainId: 'client-domain-nessie',
          clientId: 'a'.repeat(64),
          config: currentConfig,
          configUrl,
          organizationId: 'org-target',
          refreshToken: 'source-refresh-token',
          teamId: 'team-target',
        },
        expect.objectContaining({ adminPrisma: expect.anything(), prisma: expect.anything() }),
      );
    } finally {
      await app.close();
    }
  });

  it.each([
    ['missing organization', { organization_id: undefined }],
    ['empty organization', { organization_id: '' }],
    ['oversized organization', { organization_id: 'o'.repeat(257) }],
    ['missing team', { team_id: undefined }],
    ['empty team', { team_id: '' }],
    ['oversized team', { team_id: 't'.repeat(257) }],
    ['missing refresh token', { refresh_token: undefined }],
    ['empty refresh token', { refresh_token: '' }],
    ['oversized refresh token', { refresh_token: 'r'.repeat(4097) }],
    ['missing grant literal', { grant_type: undefined }],
    ['wrong grant literal', { grant_type: 'team_switch' }],
    ['wrong scalar types', { organization_id: 123, team_id: false }],
    ['client operation id', { operation_id: 'not-supported' }],
  ])('rejects %s as INVALID_TOKEN_REQUEST', async (_name, overrides) => {
    const app = await createTestApp();
    try {
      const response = await app.inject({
        method: 'POST',
        remoteAddress: nextRemoteAddress(),
        url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
        payload: requestPayload(overrides),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Request failed' });
      expect(exchangeTeamSwitchForTokensMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    ['UNRELATED_FORBIDDEN', 403, 'FORBIDDEN'],
    ['UNRELATED_CONFLICT', 409, 'BAD_REQUEST'],
  ] as const)('keeps unrelated %s codes private in production', async (code, status, appCode) => {
    exchangeTeamSwitchForTokensMock.mockRejectedValueOnce(new AppError(appCode, status, code));
    const app = await createTestApp();
    try {
      const response = await app.inject({
        method: 'POST',
        remoteAddress: nextRemoteAddress(),
        url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
        payload: requestPayload(),
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: 'Request failed' });
    } finally {
      await app.close();
    }
  });

  it.each([
    ['TEAM_NOT_AVAILABLE', 403, 'FORBIDDEN'],
    ['INTERACTION_REQUIRED', 403, 'FORBIDDEN'],
    ['TEAM_SWITCH_CONFLICT', 409, 'BAD_REQUEST'],
  ] as const)('exposes the safe %s outcome in production', async (code, status, appCode) => {
    exchangeTeamSwitchForTokensMock.mockRejectedValueOnce(new AppError(appCode, status, code));
    const app = await createTestApp();
    try {
      const response = await app.inject({
        method: 'POST',
        remoteAddress: nextRemoteAddress(),
        url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
        payload: requestPayload(),
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: 'Request failed', code });
    } finally {
      await app.close();
    }
  });

  it('exposes the stable invalid-refresh code after client authentication', async () => {
    exchangeTeamSwitchForTokensMock.mockRejectedValueOnce(
      new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN'),
    );
    const app = await createTestApp();
    try {
      const response = await app.inject({
        method: 'POST',
        remoteAddress: nextRemoteAddress(),
        url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
        payload: requestPayload(),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: 'Request failed',
        code: 'INVALID_REFRESH_TOKEN',
      });
    } finally {
      await app.close();
    }
  });

  it('keeps a missing authenticated client identity opaque', async () => {
    attachAuthenticatedClient = false;
    const app = await createTestApp();
    try {
      const response = await app.inject({
        method: 'POST',
        remoteAddress: nextRemoteAddress(),
        url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
        payload: requestPayload(),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Request failed' });
      expect(exchangeTeamSwitchForTokensMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
