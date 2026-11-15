import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../src/utils/errors.js';
import { buildPublicErrorBody } from '../../src/utils/error-response.js';

const request = { method: 'POST', routeOptions: { url: '/billing/v1/browser/reservations' },
  billingAppKey: { id: 'verified-app-key' } } as FastifyRequest;

describe('browser billing production refusal boundary', () => {
  beforeEach(() => vi.stubEnv('DEBUG_ENABLED', 'false'));
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [402, 'BILLING_SEAT_PAYMENT_REQUIRED'],
    [402, 'BILLING_BROWSER_INSUFFICIENT_CREDITS'],
    [503, 'BILLING_BROWSER_TARIFF_UNAVAILABLE'],
    [403, 'BILLING_BROWSER_LIVE_CREDITS_REQUIRED'],
    [403, 'BILLING_APP_KEY_PURPOSE_MISMATCH'],
    [403, 'BILLING_APP_CREDENTIAL_REVOKED'],
    [402, 'BUDGET_CREDITS_EXHAUSTED'],
    [403, 'BUDGET_EVIDENCE_INCOMPLETE'],
  ] as const)('preserves the actionable %i %s code without internal detail', (statusCode, code) => {
    expect(buildPublicErrorBody({ request, statusCode, error: new AppError('FORBIDDEN', statusCode, code) }))
      .toEqual({ error: 'Request failed', code });
    for (const rejected of [undefined, { ...request, billingAppKey: undefined },
      { ...request, routeOptions: { url: '/billing/v1/effective-tariff' } }]) {
      expect(buildPublicErrorBody({ request: rejected as FastifyRequest | undefined, statusCode,
        error: new AppError('FORBIDDEN', statusCode, code) })).toEqual({ error: 'Request failed' });
    }
  });

  it.each(['BILLING_ACTOR_SUBJECT_MISMATCH', 'BILLING_BROWSER_RUN_OWNER_MISMATCH', 'INTERNAL_DATABASE_ERROR'])(
    'keeps unrelated authority and internal diagnostics generic: %s', code => {
      expect(buildPublicErrorBody({ statusCode: 403, error: new AppError('FORBIDDEN', 403, code) }))
        .toEqual({ error: 'Request failed' });
    },
  );

  it('preserves the existing billing-setup recovery code on reserve and claim', () => {
    for (const url of ['/billing/v1/browser/reservations', '/billing/v1/browser/reservations/claim']) {
      expect(buildPublicErrorBody({ request: { ...request, routeOptions: { url } } as FastifyRequest,
        statusCode: 402, error: new AppError('FORBIDDEN', 402, 'NESSIE_BILLING_SETUP_REQUIRED') }))
        .toEqual({ error: 'Request failed', code: 'NESSIE_BILLING_SETUP_REQUIRED' });
    }
  });
});
