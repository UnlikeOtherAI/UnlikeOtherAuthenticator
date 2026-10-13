import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { VerifiedBillingAppKey } from '../../src/services/billing-app-key.service.js';
vi.mock('../../src/services/billing-product-authority.service.js', () => ({
  lockCommercialAuthority: async () => ({ id: 'enrollment' }), commercialMember: async () => true,
}));
vi.mock('../../src/services/billing-product-private-policy.service.js', () => ({ privateCompanyPolicy: async () => null }));
import { getProductEntitlement } from '../../src/services/billing-product-entitlement.service.js';

const now = new Date('2026-10-16T18:00:00Z');
function fixture(status: string, withSeatDebt = true) {
  const incidents = [{ id: 'storage-debt', category: 'storage', failedAt: now,
    graceEndsAt: new Date('2026-10-19T18:00:00Z'), billingTimezone: 'UTC', baseSubscriptionId: null },
  ...(withSeatDebt ? [{ id: 'seat-debt', category: 'seat', failedAt: now,
    graceEndsAt: new Date('2026-10-19T19:00:00Z'), billingTimezone: 'UTC', baseSubscriptionId: 'base' }] : [])];
  const subscriptions = vi.fn(async () => [{ stripeSubscription: { id: 'base', status },
    capacityRevisions: [], seatPolicy: 'AUTOMATIC', commercialEndsAt: null }]);
  const tx = { billingProductPolicyRevision: { findFirst: async () => null },
    billingCommercialIncident: { findMany: async () => incidents, findFirst: async () => incidents[0] },
    billingStorageObservation: { findFirst: async () => null },
    billingSeatSubscription: { findMany: subscriptions }, billingStorageSubscription: { findMany: async () => [] },
    billingStorageMandate: { findFirst: async () => null }, billingTariffTermEvent: { findFirst: async () => null } };
  const prisma = { $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx) } as unknown as PrismaClient;
  const credential = { purpose: 'COMMERCIAL_WORKER', service: { id: 'service' } } as VerifiedBillingAppKey;
  const read = () => getProductEntitlement({ credential, request: { product: 'nessie', organisation_id: 'company' } },
    { prisma, now: () => now });
  return { read, incidents, subscriptions };
}
describe('company seat access and independent unresolved liabilities', () => {
  it.each(['past_due', 'unpaid'])('preserves %s seat access while earlier storage and exact seat debts remain in grace', async (status) => {
    const data = fixture(status);
    await expect(data.read()).resolves.toMatchObject({ full_access: true, standing: 'grace',
      dunning: { incident_id: 'storage-debt' }, seats: { admitted: false } });
    expect(data.subscriptions).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ teamId: null }) }));
  });
  it.each(['past_due', 'unpaid'])('holds %s without original exact seat failure instead of granting indefinite access or early downgrade', async (status) => {
    await expect(fixture(status, false).read()).rejects.toThrow('BILLING_SEAT_PAYMENT_RECONCILIATION_REQUIRED');
  });
  it('restricts when any unresolved required company deadline expires', async () => {
    const data = fixture('past_due'); data.incidents[0].graceEndsAt = now;
    await expect(data.read()).resolves.toMatchObject({ full_access: false, standing: 'restricted',
      seats: { can_admit_members: false }, storage: { can_upload: false } });
  });
  it('does not turn another team or an ended seat debt into a current company agreement', async () => {
    const data = fixture('active'); data.subscriptions.mockResolvedValueOnce([]);
    data.incidents.splice(0, 1);
    await expect(data.read()).resolves.toMatchObject({ full_access: false, history_window_days: 14,
      seats: { can_admit_members: false }, standing: 'grace', dunning: { incident_id: 'seat-debt' } });
  });
});
