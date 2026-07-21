import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { parseEnv, type Env } from '../../src/config/env.js';
import {
  fetchLedgerMeteringPortfolio,
  fetchLedgerMeteringUsage,
} from '../../src/services/billing-ledger-collector.service.js';

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
    LEDGER_BILLING_BASE_URL: 'https://ledger.unlikeotherai.com',
    LEDGER_BILLING_APP_KEY: 'lk_uoa_dedicated_app_key_123456789',
    LEDGER_BILLING_APP_KEY_ID: 'tk_uoa_billing_collector',
    LEDGER_BILLING_ASSERTION_AUDIENCE: 'https://ledger.unlikeotherai.com',
    UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
    UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON: JSON.stringify({ keys: [publicJwk] }),
  });
});

function rawMeteringResponse(groupBy: 'service' | 'user' = 'service') {
  return {
    schemaVersion: 1,
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
      calls: '2',
      usageByService: [
        {
          billingProduct: 'deepwater',
          callerProduct: 'nessie',
          originProduct: 'nessie',
          serviceId: 'openai',
          usageUnit: 'tokens',
          calls: '2',
          rawProviderUsage: {
            unitsIn: '100',
            unitsCachedIn: '10',
            unitsOut: '25',
          },
        },
      ],
      costs: [
        {
          billingProduct: 'deepwater',
          callerProduct: 'nessie',
          originProduct: 'nessie',
          serviceId: 'openai',
          costProvenance: 'provider_pricebook',
          rawProviderCurrency: 'USD',
          calls: '2',
          rawProviderEstimatedCost: '1.2',
          rawProviderActualCost: '1.1',
          rawProviderSelectedCost: '1.1',
        },
      ],
    },
    groupBy,
    breakdown: [
      {
        dimension: groupBy === 'user' ? 'user_123' : 'openai',
        billingProduct: 'deepwater',
        callerProduct: 'nessie',
        originProduct: 'nessie',
        serviceId: 'openai',
        usageUnit: 'tokens',
        costProvenance: 'provider_pricebook',
        rawProviderCurrency: 'USD',
        calls: '2',
        rawProviderUsage: {
          unitsIn: '100',
          unitsCachedIn: '10',
          unitsOut: '25',
        },
        rawProviderEstimatedCost: '1.2',
        rawProviderActualCost: '1.1',
        rawProviderSelectedCost: '1.1',
      },
    ],
    snapshot: {
      cursor: 'mus_0123456789ABCDEFGHIJKLMNOPQRSTUV',
      id: 'mus_0123456789ABCDEFGHIJKLMNOPQRSTUV',
      capturedAt: '2026-07-19T12:00:00.000Z',
      immutable: true,
    },
  };
}

function rawPortfolioResponse(groupBy: 'service' | 'user' = 'service') {
  const usage = rawMeteringResponse(groupBy);
  return {
    ...usage,
    contract: 'metering-portfolio-v1',
    perspectiveProduct: usage.product,
    product: undefined,
    scope: {
      organizationId: usage.scope.organizationId,
      teamId: usage.scope.teamId,
      month: usage.scope.month,
      startsAt: usage.scope.startsAt,
      endsAt: usage.scope.endsAt,
    },
    totals: {
      ...usage.totals,
      usageByService: [
        ...usage.totals.usageByService,
        {
          ...usage.totals.usageByService[0],
          billingProduct: 'nessie',
          callerProduct: 'nessie',
          originProduct: 'nessie',
        },
      ],
    },
    breakdown: [
      ...usage.breakdown,
      {
        ...usage.breakdown[0],
        billingProduct: 'nessie',
        callerProduct: 'nessie',
        originProduct: 'nessie',
      },
    ],
    snapshot: {
      cursor: 'mup_0123456789ABCDEFGHIJKLMNOPQRSTUV',
      id: 'mup_0123456789ABCDEFGHIJKLMNOPQRSTUV',
      capturedAt: usage.snapshot.capturedAt,
      immutable: true,
    },
  };
}

describe('Ledger raw metering collector', () => {
  it('uses UOA’s dedicated Ledger key and a narrowly signed metering assertion', async () => {
    const now = Math.floor(Date.parse('2026-07-19T12:00:00.000Z') / 1000);
    let responseText = '';
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Ledger-App-Key')).toBe('lk_uoa_dedicated_app_key_123456789');
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
        sub: 'uoa-metering-reader',
        azp: 'tk_uoa_billing_collector',
        source_domain: 'authentication.unlikeotherai.com',
        scope: 'metering.read',
        product: 'deepwater',
        organization_id: 'org_123',
        team_id: 'team_123',
        billing_month: '2026-07',
      });
      expect(typeof verified.payload.jti).toBe('string');

      responseText = JSON.stringify(rawMeteringResponse());
      return new Response(responseText, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await fetchLedgerMeteringUsage(
      {
        product: 'deepwater',
        organisationId: 'org_123',
        teamId: 'team_123',
        billingMonth: '2026-07',
        groupBy: 'service',
      },
      {
        env,
        fetch: fetchMock as unknown as typeof fetch,
        now: () => now,
      },
    );

    expect(result).toMatchObject({
      schemaVersion: 1,
      groupBy: 'service',
      calls: '2',
      lines: [
        {
          serviceId: 'openai',
          actualProviderCost: '1.1',
          selectedProviderCost: '1.1',
          billingProduct: 'deepwater',
          callerProduct: 'nessie',
          userId: null,
        },
      ],
      snapshot: {
        cursor: 'mus_0123456789ABCDEFGHIJKLMNOPQRSTUV',
        id: 'mus_0123456789ABCDEFGHIJKLMNOPQRSTUV',
        immutable: true,
      },
    });
    expect(result.snapshot.sha256).toBe(createHash('sha256').update(responseText).digest('hex'));
    const requestedUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(requestedUrl.toString()).toBe(
      'https://ledger.unlikeotherai.com/v1/metering/usage?group_by=service',
    );
  });

  it('fails closed if Ledger returns a commercial field or a mismatched snapshot id', async () => {
    for (const response of [
      { ...rawMeteringResponse(), customerCharges: [] },
      {
        ...rawMeteringResponse(),
        snapshot: {
          ...rawMeteringResponse().snapshot,
          id: 'mus_1123456789ABCDEFGHIJKLMNOPQRSTUV',
        },
      },
      {
        ...rawMeteringResponse(),
        scope: {
          ...rawMeteringResponse().scope,
          startsAt: '2026-07-02T00:00:00.000Z',
        },
      },
    ]) {
      await expect(
        fetchLedgerMeteringUsage(
          {
            product: 'deepwater',
            organisationId: 'org_123',
            teamId: 'team_123',
            billingMonth: '2026-07',
            groupBy: 'service',
          },
          {
            env,
            fetch: vi.fn().mockResolvedValue(
              new Response(JSON.stringify(response), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            ),
          },
        ),
      ).rejects.toThrow('LEDGER_METERING_RESPONSE_INVALID');
    }
  });

  it('requests one exact team portfolio with the statement product only as perspective', async () => {
    const now = Math.floor(Date.parse('2026-07-19T12:00:00.000Z') / 1000);
    let responseText = '';
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const assertion = new Headers(init?.headers).get('X-UOA-Service-Assertion');
      const verified = await jwtVerify(assertion as string, verificationKey, {
        algorithms: ['RS256'],
        issuer: 'https://authentication.unlikeotherai.com',
        audience: 'https://ledger.unlikeotherai.com',
        currentDate: new Date(now * 1000),
      });
      expect(verified.payload).toMatchObject({
        sub: 'uoa-metering-reader',
        scope: 'metering.read',
        product: 'deepwater',
        organization_id: 'org_123',
        team_id: 'team_123',
        billing_month: '2026-07',
        view: 'team_portfolio',
      });
      responseText = JSON.stringify(rawPortfolioResponse('user'), (_key, value) =>
        value === undefined ? undefined : value,
      );
      return new Response(responseText, { status: 200 });
    });

    const result = await fetchLedgerMeteringPortfolio(
      {
        product: 'deepwater',
        organisationId: 'org_123',
        teamId: 'team_123',
        billingMonth: '2026-07',
        groupBy: 'user',
      },
      { env, fetch: fetchMock as unknown as typeof fetch, now: () => now },
    );

    expect(result).toMatchObject({
      contract: 'metering-portfolio-v1',
      perspectiveProduct: 'deepwater',
      groupBy: 'user',
      lines: [
        expect.objectContaining({ billingProduct: 'deepwater' }),
        expect.objectContaining({ billingProduct: 'nessie' }),
      ],
      snapshot: { cursor: 'mup_0123456789ABCDEFGHIJKLMNOPQRSTUV' },
    });
    expect(result.scope).not.toHaveProperty('userId');
    expect(result.snapshot.sha256).toBe(createHash('sha256').update(responseText).digest('hex'));
    expect((fetchMock.mock.calls[0]?.[0] as URL).toString()).toBe(
      'https://ledger.unlikeotherai.com/v1/metering/portfolio?group_by=user',
    );
  });

  it('accepts Ledger’s committed public cross-product portfolio fixture exactly', async () => {
    const responseText = await readFile(
      new URL('../fixtures/ledger-metering-portfolio-v1.example.json', import.meta.url),
      'utf8',
    );
    const result = await fetchLedgerMeteringPortfolio(
      {
        product: 'nessie',
        organisationId: 'org_example',
        teamId: 'team_example',
        billingMonth: '2026-07',
        groupBy: 'service',
      },
      {
        env,
        fetch: vi.fn().mockResolvedValue(new Response(responseText, { status: 200 })),
      },
    );

    expect(result.scope).toEqual({
      organizationId: 'org_example',
      teamId: 'team_example',
      month: '2026-07',
      startsAt: '2026-07-01T00:00:00.000Z',
      endsAt: '2026-08-01T00:00:00.000Z',
    });
    expect(result.lines.map((line) => line.billingProduct)).toEqual(['deepwater', 'nessie']);
  });

  it('rejects portfolio responses with commercial fields or a mismatched perspective', async () => {
    for (const response of [
      { ...rawPortfolioResponse(), tariffs: [] },
      { ...rawPortfolioResponse(), perspectiveProduct: 'nessie' },
      {
        ...rawPortfolioResponse(),
        scope: {
          ...rawPortfolioResponse().scope,
          endsAt: '2026-08-02T00:00:00.000Z',
        },
      },
    ]) {
      await expect(
        fetchLedgerMeteringPortfolio(
          {
            product: 'deepwater',
            organisationId: 'org_123',
            teamId: 'team_123',
            billingMonth: '2026-07',
            groupBy: 'service',
          },
          {
            env,
            fetch: vi
              .fn()
              .mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })),
          },
        ),
      ).rejects.toThrow('LEDGER_METERING_PORTFOLIO_RESPONSE_INVALID');
    }
  });
});
