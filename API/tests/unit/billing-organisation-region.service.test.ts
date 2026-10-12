import { describe, expect, it, vi } from 'vitest';
import {
  setOrganisationBillingRegion, suggestedBillingRegion,
} from '../../src/services/billing-organisation-region.service.js';

describe('organisation billing region', () => {
  it('suggests UK for GB, Europe for the EU, EEA and Switzerland, and US for anything else', () => {
    expect(suggestedBillingRegion('GB')).toBe('UK');
    for (const country of ['CZ', 'DE', 'IE', 'FR', 'IS', 'LI', 'NO', 'CH', ' cz ']) expect(suggestedBillingRegion(country)).toBe('EUROPE');
    for (const country of ['US', 'CA', 'AU', 'TR', '', null, undefined]) expect(suggestedBillingRegion(country)).toBe('US');
  });

  function setup(existing: Array<{ region: string }> = []) {
    const rows = [...existing];
    const db = {
      billingOrganisationRegion: {
        findUnique: vi.fn(async () => (rows[0] ? { orgId: 'org_1', ...rows[0] } : null)),
        create: vi.fn(async ({ data }: { data: { region: string } }) => { rows.push(data); return data; }),
      },
      billingOrganisationInvoiceProfile: { findUnique: vi.fn(async () => ({ billingAddress: { country: 'CZ' } })) },
      $transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(db)),
    };
    const deps = { prisma: db as never, resolveTariff: vi.fn(async () => ({ actor: { jti: 'jti', tv: 0, exp: 9 } })) as never,
      isOrganisationManager: vi.fn(async () => true), authorizeAction: vi.fn(async () => ({})) as never,
      captureRate: vi.fn(async () => undefined) };
    return { db, deps };
  }
  const params = { request: { product: 'nessie', organisationId: 'org_1', teamId: 'team_1', userId: 'user_1' },
    actorToken: 'actor', credential: { id: 'key', service: { id: 'svc' } } as never,
    endpoint: '/billing/v1/organisation-billing/region' as const };

  it('is chosen once by a manager, repeats as a no-op and refuses any other region', async () => {
    const { db, deps } = setup();
    expect(await setOrganisationBillingRegion({ ...params, region: 'EUROPE' }, deps)).toEqual({ region: 'EUROPE',
      currency: 'EUR', suggested_region: 'EUROPE', suggested_currency: 'EUR', suggested_from: 'billing_country',
      can_set: false });
    expect(db.billingOrganisationRegion.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      orgId: 'org_1', region: 'EUROPE', currency: 'EUR', setByUserId: 'user_1' }) });
    // Credits bought in USD before the choice are valued at the rate captured now.
    expect(deps.captureRate).toHaveBeenCalledWith('org_1');
    await setOrganisationBillingRegion({ ...params, region: 'EUROPE' }, deps);
    await expect(setOrganisationBillingRegion({ ...params, region: 'UK' }, deps)).rejects.toThrow('BILLING_REGION_IMMUTABLE');
    expect(db.billingOrganisationRegion.create).toHaveBeenCalledTimes(1);
  });

  it('names the billing country as the source of any country\'s suggestion, and nothing for the US default',
    async () => {
      const { billingRegionView } = await import('../../src/services/billing-organisation-region.service.js');
      const cases = [[{ country: 'US' }, 'US', 'billing_country'], [{ country: 'CA' }, 'US', 'billing_country'],
        [{ country: 'GB' }, 'UK', 'billing_country'], [{ country: ' ' }, 'US', null], [{}, 'US', null],
        [null, 'US', null]] as const;
      for (const [billingAddress, region, from] of cases) {
        const db = { billingOrganisationRegion: { findUnique: vi.fn(async () => null) },
          billingOrganisationInvoiceProfile: { findUnique: vi.fn(async () => (billingAddress === null ? null
            : { billingAddress })) } };
        expect(await billingRegionView('org_1', true, db as never)).toMatchObject({ suggested_region: region,
          suggested_from: from });
      }
    });

  it('refuses a member who is not an organisation owner or admin before any write', async () => {
    const { db, deps } = setup();
    deps.isOrganisationManager.mockResolvedValue(false);
    await expect(setOrganisationBillingRegion({ ...params, region: 'US' }, deps)).rejects.toThrow('BILLING_ORG_MANAGER_REQUIRED');
    expect(db.billingOrganisationRegion.create).not.toHaveBeenCalled();
  });
});
