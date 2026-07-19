import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { parseEnv, type Env } from '../../src/config/env.js';
import { fetchLedgerBillingUsage } from '../../src/services/billing-ledger-collector.service.js';

let env: Env;
let verificationKey: CryptoKey;

beforeAll(async () => {
  const keyPair = await generateKeyPair('RS256', { extractable: true });
  verificationKey = keyPair.publicKey;
  const privateJwk = await exportJWK(keyPair.privateKey);
  const publicJwk = await exportJWK(keyPair.publicKey);
  Object.assign(privateJwk, {
    kid: 'uoa-billing-collector-current',
    alg: 'RS256',
    use: 'sig',
  });
  Object.assign(publicJwk, {
    kid: 'uoa-billing-collector-current',
    alg: 'RS256',
    use: 'sig',
  });
  env = parseEnv({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    PUBLIC_BASE_URL: 'https://authentication.unlikeotherai.com',
    SHARED_SECRET: 'test-shared-secret-with-enough-length',
    AUTH_SERVICE_IDENTIFIER: 'authentication.unlikeotherai.com',
    STRIPE_BILLING_ENABLED: 'true',
    STRIPE_SECRET_KEY: 'sk_test_collector',
    STRIPE_WEBHOOK_SECRET: 'whsec_collector',
    LEDGER_BILLING_BASE_URL: 'https://ledger.unlikeotherai.com',
    LEDGER_BILLING_APP_KEY: 'lk_uoa_dedicated_app_key_123456789',
    LEDGER_BILLING_APP_KEY_ID: 'tk_uoa_billing_collector',
    LEDGER_BILLING_ASSERTION_AUDIENCE: 'https://ledger.unlikeotherai.com',
    UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
    UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON: JSON.stringify({ keys: [publicJwk] }),
  });
});

describe('Ledger billing collector', () => {
  it('uses UOA’s dedicated Ledger app key plus an exact signed service assertion', async () => {
    const now = Math.floor(Date.parse('2026-07-19T12:00:00.000Z') / 1000);
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Ledger-App-Key')).toBe(
        'lk_uoa_dedicated_app_key_123456789',
      );
      const assertion = headers.get('X-UOA-Service-Assertion');
      expect(assertion).toBeTruthy();
      const verified = await jwtVerify(assertion as string, verificationKey, {
        algorithms: ['RS256'],
        issuer: 'https://authentication.unlikeotherai.com',
        audience: 'https://ledger.unlikeotherai.com',
        currentDate: new Date(now * 1000),
      });
      expect(verified.protectedHeader).toMatchObject({
        alg: 'RS256',
        kid: 'uoa-billing-collector-current',
        typ: 'uoa-billing-service+jwt',
      });
      expect(verified.payload).toMatchObject({
        sub: 'uoa-billing-collector',
        azp: 'tk_uoa_billing_collector',
        source_domain: 'authentication.unlikeotherai.com',
        scope: 'billing.read',
        product: 'deepwater',
        organization_id: 'org_123',
        team_id: 'team_123',
        billing_month: '2026-07',
      });
      expect(typeof verified.payload.jti).toBe('string');

      return new Response(
        JSON.stringify({
          schemaVersion: 4,
          product: 'deepwater',
          scope: {
            organizationId: 'org_123',
            teamId: 'team_123',
            userId: null,
            month: '2026-07',
            startsAt: '2026-07-01T00:00:00.000Z',
            endsAt: '2026-08-01T00:00:00.000Z',
          },
          totals: {
            calls: 0,
            usageByService: [],
            amounts: [],
            customerCharges: [],
          },
          groupBy: 'service',
          breakdown: [],
          monthlyComponents: [],
          snapshot: {
            cursor: 'bus_collector_snapshot_123',
            capturedAt: '2026-07-19T12:00:00.000Z',
            immutable: true,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const result = await fetchLedgerBillingUsage(
      {
        product: 'deepwater',
        organisationId: 'org_123',
        teamId: 'team_123',
        billingMonth: '2026-07',
      },
      {
        env,
        fetch: fetchMock as unknown as typeof fetch,
        now: () => now,
      },
    );

    expect(result.snapshot.cursor).toBe('bus_collector_snapshot_123');
    const requestedUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(requestedUrl.toString()).toBe(
      'https://ledger.unlikeotherai.com/v1/billing/usage?group_by=service',
    );
  });
});
