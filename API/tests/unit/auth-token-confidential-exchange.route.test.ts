import type { ClientConfig } from '../../src/services/config.service.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testUiTheme } from '../helpers/test-config.js';

const exchangeConfidentialSubjectTokenMock = vi.fn();
let currentConfig: ClientConfig;

vi.mock('../../src/middleware/config-verifier.js', () => ({
  configVerifier: async (request: {
    query?: { config_url?: string };
    configUrl?: string;
    configJwt?: string;
    config?: ClientConfig;
  }): Promise<void> => {
    request.configUrl = request.query?.config_url;
    request.configJwt = 'verified-config-jwt';
    request.config = currentConfig;
  },
}));

vi.mock('../../src/middleware/domain-hash-auth.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/middleware/domain-hash-auth.js')
  >('../../src/middleware/domain-hash-auth.js');
  return {
    ...actual,
    requireDomainHashAuth: async (request: {
      domainAuthClientId?: string;
    }): Promise<void> => {
      request.domainAuthClientId = 'a'.repeat(64);
    },
  };
});

vi.mock('../../src/services/confidential-token-exchange.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/confidential-token-exchange.service.js')
  >('../../src/services/confidential-token-exchange.service.js');
  return {
    ...actual,
    exchangeConfidentialSubjectToken: (...args: unknown[]) =>
      exchangeConfidentialSubjectTokenMock(...args),
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

describe('POST /auth/token confidential grant', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    currentConfig = config();
    exchangeConfidentialSubjectTokenMock.mockResolvedValue({
      accessToken: 'ledger-access-token',
      expiresInSeconds: 300,
      issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'ai.invoke',
    });
  });

  afterEach(() => {
    if (originalSharedSecret === undefined) {
      Reflect.deleteProperty(process.env, 'SHARED_SECRET');
    } else {
      process.env.SHARED_SECRET = originalSharedSecret;
    }
    if (originalDatabaseUrl === undefined) {
      Reflect.deleteProperty(process.env, 'DATABASE_URL');
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    vi.clearAllMocks();
  });

  it('returns the RFC 8693 response without refresh or client credentials', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url:
          '/auth/token?config_url=' +
          encodeURIComponent('https://api.nessie.works/auth/config'),
        headers: { authorization: `Bearer ${'a'.repeat(64)}` },
        payload: {
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token: 'source.jwt.assertion',
          subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
          resource: 'https://ledger.unlikeotherai.com',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        access_token: 'ledger-access-token',
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'ai.invoke',
      });
      expect(response.json()).not.toHaveProperty('refresh_token');
      expect(response.json()).not.toHaveProperty('client_id');
      expect(exchangeConfidentialSubjectTokenMock).toHaveBeenCalledWith(
        {
          subjectToken: 'source.jwt.assertion',
          resource: 'https://ledger.unlikeotherai.com',
          config: currentConfig,
          configJwt: 'verified-config-jwt',
        },
        expect.objectContaining({ prisma: expect.anything() }),
      );
    } finally {
      await app.close();
    }
  });

  it('rejects a malformed token-exchange request before the service runs', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url:
          '/auth/token?config_url=' +
          encodeURIComponent('https://api.nessie.works/auth/config'),
        payload: {
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token: 'source.jwt.assertion',
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          resource: 'https://ledger.unlikeotherai.com',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(exchangeConfidentialSubjectTokenMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not place authenticated confidential users behind the legacy 10/minute IP bucket', async () => {
    currentConfig = {
      ...config(),
      domain: `shared-egress-${randomUUID()}.example`,
    };
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      for (let requestNumber = 0; requestNumber < 11; requestNumber += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/token?config_url=' + encodeURIComponent('https://source.example/config'),
          headers: { authorization: `Bearer ${'a'.repeat(64)}` },
          payload: {
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            subject_token: `source.jwt.assertion.${requestNumber}`,
            subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            resource: 'https://ledger.unlikeotherai.com',
          },
        });
        expect(response.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it('retains an authenticated per-domain abuse ceiling for confidential exchange', async () => {
    currentConfig = {
      ...config(),
      domain: `rate-limit-${randomUUID()}.example`,
    };
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const request = (requestNumber: number) =>
        app.inject({
          method: 'POST',
          url: '/auth/token?config_url=' + encodeURIComponent('https://source.example/config'),
          headers: { authorization: `Bearer ${'a'.repeat(64)}` },
          payload: {
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            subject_token: `source.jwt.assertion.${requestNumber}`,
            subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            resource: 'https://ledger.unlikeotherai.com',
          },
        });
      for (let requestNumber = 0; requestNumber < 600; requestNumber += 1) {
        expect((await request(requestNumber)).statusCode).toBe(200);
      }
      expect((await request(601)).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
