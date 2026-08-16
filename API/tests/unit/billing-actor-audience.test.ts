import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import {
  BILLING_ACTOR_ENDPOINTS,
  assertBillingActorAudience,
  billingActorAudience,
} from '../../src/services/billing-actor-audience.service.js';

const PUBLIC_BASE_URL = 'https://authentication.unlikeotherai.com';
const LEGACY_AUDIENCE = `${PUBLIC_BASE_URL}/billing/v1/effective-tariff`;

const envNames = ['PUBLIC_BASE_URL', 'BILLING_ACTOR_AUDIENCE_MODE'] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]])) as Record<
  (typeof envNames)[number],
  string | undefined
>;

beforeAll(() => {
  process.env.PUBLIC_BASE_URL = PUBLIC_BASE_URL;
  Reflect.deleteProperty(process.env, 'BILLING_ACTOR_AUDIENCE_MODE');
});

afterAll(() => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

describe('billing actor audience derivation', () => {
  it('joins the deployment public base URL with the exact endpoint path', () => {
    expect(billingActorAudience('/billing/v2/customer-statement')).toBe(
      `${PUBLIC_BASE_URL}/billing/v2/customer-statement`,
    );
  });

  it('gives every endpoint a distinct audience', () => {
    const audiences = BILLING_ACTOR_ENDPOINTS.map((endpoint) => billingActorAudience(endpoint));
    expect(new Set(audiences).size).toBe(BILLING_ACTOR_ENDPOINTS.length);
  });

  it('accepts the endpoint audience and reports which contract was satisfied', () => {
    expect(
      assertBillingActorAudience({
        presented: `${PUBLIC_BASE_URL}/billing/v1/credits`,
        endpoint: '/billing/v1/credits',
        legacyAudience: LEGACY_AUDIENCE,
      }),
    ).toBe('endpoint');
  });

  it('reports the legacy contract separately so it can be logged and later refused', () => {
    expect(
      assertBillingActorAudience({
        presented: LEGACY_AUDIENCE,
        endpoint: '/billing/v1/credits',
        legacyAudience: LEGACY_AUDIENCE,
      }),
    ).toBe('legacy');
  });

  it('refuses an audience that is neither', () => {
    expect(() =>
      assertBillingActorAudience({
        presented: `${PUBLIC_BASE_URL}/billing/v1/credits`,
        endpoint: '/billing/v1/cancellation/confirm',
        legacyAudience: LEGACY_AUDIENCE,
      }),
    ).toThrowError(/BILLING_ACTOR_AUDIENCE_MISMATCH/);
  });
});

describe('billing actor endpoint registry', () => {
  // A typo here would mint an audience no product could ever produce, and would
  // 401 every call to that endpoint the moment the deployment enforces. So the
  // declared list is checked against the paths the routes actually register.
  it('declares only paths the server actually registers', async () => {
    const app = await createApp();
    try {
      for (const endpoint of BILLING_ACTOR_ENDPOINTS) {
        expect(
          app.hasRoute({ method: 'POST', url: endpoint }),
          `${endpoint} is declared as an actor endpoint but no POST route registers it`,
        ).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  it('supplies an endpoint everywhere an actor header is read', async () => {
    const dir = fileURLToPath(new URL('../../src/routes/billing/', import.meta.url));
    const files = [
      'cancellation.ts',
      'credit-funding-actions.ts',
      'credits.ts',
      'customer-statement.ts',
      'effective-tariff.ts',
      'recurring-addons.ts',
      'service-access.ts',
      'stripe-checkout.ts',
      'stripe-subscription.ts',
    ];
    for (const file of files) {
      const source = await readFile(`${dir}${file}`, 'utf8');
      const readers = source.match(/readBillingActorHeader\(/g)?.length ?? 0;
      const endpoints = source.match(/\bendpoint[,:]/g)?.length ?? 0;
      expect(readers, `${file} reads no actor header`).toBeGreaterThan(0);
      expect(endpoints, `${file} names no endpoint`).toBeGreaterThan(0);
    }
  });
});
