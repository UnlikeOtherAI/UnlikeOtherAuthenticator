import type { HandshakeErrorLog } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/config/env.js';
import {
  listHandshakeErrorLogs,
  recordHandshakeErrorLog,
} from '../../src/services/handshake-error-log.service.js';

function testEnv(overrides?: Partial<Env>): Env {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 3000,
    PUBLIC_BASE_URL: 'https://auth.example.com',
    LOG_LEVEL: 'info',
    SHARED_SECRET: 'test-shared-secret-with-enough-length',
    AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
    CONFIG_JWKS_URL: 'https://auth.example.com/.well-known/jwks.json',
    DATABASE_URL: 'postgres://example.invalid/db',
    ACCESS_TOKEN_TTL: '30m',
    REFRESH_TOKEN_TTL_DAYS: 30,
    TOKEN_PRUNE_RETENTION_DAYS: 7,
    LOG_RETENTION_DAYS: 90,
    AI_TRANSLATION_PROVIDER: 'disabled',
    ...overrides,
  };
}

describe('handshake-error-log.service', () => {
  it('records sanitized handshake error log rows', async () => {
    const calls: Record<string, unknown> = {};
    const prisma = {
      handshakeErrorLog: {
        create: async (args: unknown) => {
          calls.create = args;
          return { id: 'he_1' };
        },
        findMany: async () => [],
      },
    };

    await recordHandshakeErrorLog(
      {
        domain: 'App.Example.com.',
        endpoint: '/auth',
        phase: 'config_domain',
        statusCode: 422,
        errorCode: 'CONFIG_DOMAIN_MISMATCH',
        summary: 'Domain mismatch',
        requestId: 'req_1',
        requestJson: { config_url: 'https://app.example.com/config' },
        responseJson: { status: 422 },
        jwtPayload: { domain: 'staging.example.com' },
        redactions: ['payload.client_secret'],
      },
      { env: testEnv(), prisma: prisma as never },
    );

    expect(calls.create).toMatchObject({
      data: {
        app: null,
        domain: 'app.example.com',
        endpoint: '/auth',
        phase: 'config_domain',
        details: [],
        missingClaims: [],
        requestId: 'req_1',
        requestJson: { config_url: 'https://app.example.com/config' },
        responseJson: { status: 422 },
        jwtPayload: { domain: 'staging.example.com' },
        redactions: ['payload.client_secret'],
      },
      select: { id: true },
    });
  });

  it('lists handshake error logs with normalized JSON fields', async () => {
    const calls: Record<string, unknown> = {};
    const row: HandshakeErrorLog = {
      id: 'he_1',
      app: null,
      appId: null,
      domain: 'app.example.com',
      organisation: null,
      endpoint: '/auth',
      phase: 'jwt_verify',
      statusCode: 401,
      errorCode: 'CONFIG_JWT_INVALID',
      summary: 'JWT invalid',
      details: ['Signature failed'],
      missingClaims: ['redirect_urls'],
      ip: null,
      userAgent: null,
      requestId: 'req_1',
      requestJson: { config_url: 'https://app.example.com/config' },
      responseJson: { status: 401 },
      jwtHeader: { alg: 'RS256' },
      jwtPayload: { domain: 'app.example.com' },
      redactions: ['payload.client_secret'],
      createdAt: new Date('2026-04-21T12:34:56.000Z'),
    };
    const prisma = {
      handshakeErrorLog: {
        create: async () => ({ id: 'he_1' }),
        findMany: async (args: unknown) => {
          calls.findMany = args;
          return [row];
        },
      },
    };

    const logs = await listHandshakeErrorLogs({ limit: 25 }, { env: testEnv(), prisma: prisma as never });

    expect(calls.findMany).toMatchObject({ orderBy: { createdAt: 'desc' }, take: 25 });
    expect(logs).toEqual([
      {
        id: 'he_1',
        ts: '2026-04-21 12:34:56',
        app: 'app.example.com',
        appId: '',
        domain: 'app.example.com',
        organisation: '',
        endpoint: '/auth',
        phase: 'jwt_verify',
        statusCode: 401,
        errorCode: 'CONFIG_JWT_INVALID',
        summary: 'JWT invalid',
        details: ['Signature failed'],
        missingClaims: ['redirect_urls'],
        ip: '',
        userAgent: '',
        requestId: 'req_1',
        requestJson: { config_url: 'https://app.example.com/config' },
        responseJson: { status: 401 },
        jwtHeader: { alg: 'RS256' },
        jwtPayload: { domain: 'app.example.com' },
        redactions: ['payload.client_secret'],
      },
    ]);
  });
});
