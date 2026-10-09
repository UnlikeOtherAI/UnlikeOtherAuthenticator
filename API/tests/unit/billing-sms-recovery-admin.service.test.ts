import { beforeEach, expect, it, vi } from 'vitest';
import { listSmsRecoveryResources, readSmsRecoveryResource } from '../../src/services/billing-sms-recovery-admin.service.js';
// Final prices here are arbitrary synthetic display values, independent of provider rating.
const db = vi.hoisted(() => ({ billingSmsNumberResource: { findMany: vi.fn(), findUnique: vi.fn() },
  billingRecurringAddonSubscription: { findMany: vi.fn() } }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => db }));
beforeEach(() => vi.clearAllMocks());
it('reads payment references for the exact resource/org/service offer and exposes only frozen customer quote', async () => {
  db.billingSmsNumberResource.findUnique.mockResolvedValue({ id: 'resource-1', serviceId: 'nessie', orgId: 'org-1',
    phoneNumber: '+441234567890', country: 'GB', state: 'refund_required', recoveryReason: 'payment_without_acquired_number',
    accountSid: null, phoneNumberSid: null, offerId: 'offer-1',
    quote: { id: 'quote-1', finalAmount: '12.34', finalCurrency: 'USD', expiresAt: new Date('2026-10-08'),
      createdAt: new Date('2026-10-07'), providerAmount: 'secret-provider-cost', source: 'secret-source' } });
  db.billingRecurringAddonSubscription.findMany.mockResolvedValue([{ id: 'subscription-1',
    stripeSubscriptionId: 'sub_fixture', initialInvoiceId: 'in_fixture', initialInvoicePaidAt: new Date('2026-10-07'),
    status: 'canceled', livemode: false, cancelAtPeriodEnd: false, account: { stripeAccountId: 'acct_fixture' } }]);
  const result = await readSmsRecoveryResource('resource-1');
  expect(result.quote.final_amount).toBe('12.34'); expect(result.refund_action_available).toBe(true);
  expect(JSON.stringify(result)).not.toContain('secret-provider-cost'); expect(JSON.stringify(result)).not.toContain('secret-source');
  expect(db.billingRecurringAddonSubscription.findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: { serviceId: 'nessie', offerId: 'offer-1', orgId: 'org-1' },
  }));
  expect(result.operator_next_step).toContain('partial, pending or mismatched evidence stays unresolved');
});
it('does not infer missing payment history or resource absence as a zero charge/refund', async () => {
  db.billingSmsNumberResource.findUnique.mockResolvedValue(null);
  await expect(readSmsRecoveryResource('unknown')).rejects.toThrow('RESOURCE_NOT_FOUND');
  expect(db.billingRecurringAddonSubscription.findMany).not.toHaveBeenCalled();
});
it('paginates recovery states without exposing paid normal resources or pretending a bounded page is complete', async () => {
  const row = { id: 'resource-1', serviceId: 'nessie', orgId: 'org-1', phoneNumber: '+441234567890',
    country: 'GB', state: 'ending', recoveryReason: 'released', createdAt: new Date('2026-10-08'), updatedAt: new Date('2026-10-08') };
  db.billingSmsNumberResource.findMany.mockResolvedValue(Array.from({ length: 101 }, (_, index) => ({ ...row, id: `resource-${index}` })));
  const result = await listSmsRecoveryResources('prior-page');
  expect(result.resources).toHaveLength(100); expect(result.next_cursor).toBe('resource-99');
  expect(db.billingSmsNumberResource.findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: { state: { in: ['ending', 'recovery_required', 'refund_required'] } }, cursor: { id: 'prior-page' }, skip: 1, take: 101,
  }));
});
