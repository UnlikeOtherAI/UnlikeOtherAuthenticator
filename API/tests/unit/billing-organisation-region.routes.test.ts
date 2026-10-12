import { BillingAppKeyPurpose } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

const appKeyService = vi.hoisted(() => ({ verifyBillingAppKey: vi.fn() }));
const lifecycleService = vi.hoisted(() => ({ readOrgBillingResponsibility: vi.fn() }));
const regionService = vi.hoisted(() => ({ setOrganisationBillingRegion: vi.fn() }));

vi.mock('../../src/services/billing-app-key.service.js', async () => ({
  ...(await vi.importActual<object>('../../src/services/billing-app-key.service.js')), ...appKeyService,
}));
vi.mock('../../src/services/billing-org-responsibility-lifecycle.service.js', async () => ({
  ...(await vi.importActual<object>('../../src/services/billing-org-responsibility-lifecycle.service.js')),
  ...lifecycleService,
}));
vi.mock('../../src/services/billing-organisation-region.service.js', async () => ({
  ...(await vi.importActual<object>('../../src/services/billing-organisation-region.service.js')), ...regionService,
}));

const originalSharedSecret = process.env.SHARED_SECRET;
const originalDatabaseUrl = process.env.DATABASE_URL;
const credential = {
  id: 'app_key_nessie', purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  service: { id: 'service_nessie', identifier: 'nessie', name: 'Nessie' },
};
const subject = { product: 'nessie', organisation_id: 'org_1', team_id: 'team_1', user_id: 'user_1' };
const fallback = { region: null, currency: null, suggested_region: 'US', suggested_currency: 'USD',
  suggested_from: null, can_set: true };
const fromCountry = { ...fallback, suggested_from: 'billing_country' };

beforeAll(() => {
  process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
  Reflect.deleteProperty(process.env, 'DATABASE_URL');
});

afterAll(() => {
  if (originalSharedSecret === undefined) Reflect.deleteProperty(process.env, 'SHARED_SECRET');
  else process.env.SHARED_SECRET = originalSharedSecret;
  if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

beforeEach(() => {
  vi.clearAllMocks();
  appKeyService.verifyBillingAppKey.mockResolvedValue(credential);
});

async function post(url: string, payload: object, protocol?: string) {
  const app = await createApp();
  await app.ready();
  try {
    return await app.inject({ method: 'POST', url, payload, headers: {
      'x-uoa-app-key': 'uoa_app_key', 'x-uoa-actor': 'signed-actor',
      ...(protocol ? { 'x-uoa-billing-region-protocol': protocol } : {}) } });
  } finally {
    await app.close();
  }
}

describe('billing region suggestion source', () => {
  it('tells a region protocol 1.1.0 consumer whether a billing country decided the suggestion', async () => {
    lifecycleService.readOrgBillingResponsibility.mockResolvedValue({ organisation_id: 'org_1', active: false,
      assumed_at: null, released_at: null, can_manage: true, billing_region: fallback });
    const unknown = await post('/billing/v1/organisation-billing', subject, '1.1.0');
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json().billing_region).toEqual(fallback);

    lifecycleService.readOrgBillingResponsibility.mockResolvedValue({ organisation_id: 'org_1', active: false,
      assumed_at: null, released_at: null, can_manage: true, billing_region: fromCountry });
    const known = await post('/billing/v1/organisation-billing', subject, '1.1.0');
    expect(known.json().billing_region).toEqual(fromCountry);
  });

  it('keeps the 1.0.0 view for a consumer that does not ask for the suggestion source', async () => {
    lifecycleService.readOrgBillingResponsibility.mockResolvedValue({ organisation_id: 'org_1', active: false,
      assumed_at: null, released_at: null, can_manage: true, billing_region: fromCountry });
    const read = await post('/billing/v1/organisation-billing', subject);
    expect(read.json().billing_region).toEqual({ region: null, currency: null, suggested_region: 'US',
      suggested_currency: 'USD', can_set: true });

    regionService.setOrganisationBillingRegion.mockResolvedValue({ ...fromCountry, region: 'US', currency: 'USD',
      can_set: false });
    const older = await post('/billing/v1/organisation-billing/region', { ...subject, region: 'US' }, '1.0.0');
    expect(older.statusCode).toBe(200);
    expect(older.json()).not.toHaveProperty('suggested_from');
    const newer = await post('/billing/v1/organisation-billing/region', { ...subject, region: 'US' }, '1.1.0');
    expect(newer.json()).toMatchObject({ region: 'US', suggested_from: 'billing_country' });
  });
});
