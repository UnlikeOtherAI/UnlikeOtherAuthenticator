import {
  BillingAssignmentScope, BillingMonthlyChargeBasis, BillingSeatChargeTiming, BillingSeatPolicy,
} from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { quoteSubscriptionMonthlyCharge } from '../../src/services/billing-monthly-subscription-quote.service.js';

const at = (value: string) => new Date(value);
const closed = (prisma: unknown) => ({ prisma: prisma as never,
  now: () => at('2028-05-01T00:00:00Z') });

function stripeSource() {
  return { id: 'stripe-sub-1', serviceId: 'service-1', tariffId: 'tariff-1',
    orgId: 'org-1', teamId: 'team-1', scope: BillingAssignmentScope.TEAM,
    status: 'active', billableFrom: at('2028-01-25T12:00:00Z'), billableUntil: null,
    tariff: { monthlyChargeBasis: BillingMonthlyChargeBasis.PER_SEAT,
      seatPolicy: BillingSeatPolicy.AUTOMATIC,
      seatChargeTiming: BillingSeatChargeTiming.PRORATED,
      monthlyAmountMinor: 290n, currency: 'USD' },
    seatSubscription: { id: 'seat-sub-1', stripeSubscriptionId: 'stripe-sub-1',
      contractServiceTermId: null, serviceId: 'service-1', tariffId: 'tariff-1',
      orgId: 'org-1', teamId: 'team-1', scope: BillingAssignmentScope.TEAM,
      seatPolicy: BillingSeatPolicy.AUTOMATIC,
      seatChargeTiming: BillingSeatChargeTiming.PRORATED,
      unitAmountMinor: 290n, currency: 'USD',
      activatedAt: at('2028-01-25T12:00:00Z'),
      baselineCapturedAt: at('2028-01-25T12:00:00Z'), baselineMemberCount: 1,
      commercialEffectiveAt: at('2028-02-01T00:00:00Z'), commercialEndsAt: null,
      endedAt: null, membershipIntervals: [{ id: 'interval-1', userId: 'user-1',
        startsAt: at('2028-01-25T12:00:00Z'), endsAt: at('2028-02-15T00:00:00Z'),
        baseline: true }], capacityRevisions: [] } };
}

describe('frozen monthly subscription quote', () => {
  it('uses exact tracked seat evidence and commercial boundary for Stripe', async () => {
    const source = stripeSource();
    const prisma = { billingStripeSubscription: { findUnique: vi.fn().mockResolvedValue(source) } };
    const quote = await quoteSubscriptionMonthlyCharge({ source: { kind: 'stripe', id: source.id },
      billingMonth: '2028-02' }, closed(prisma));
    expect(quote).toMatchObject({ amountMinor: 140n, unitAmountMinor: 290n,
      agreementId: 'seat-sub-1', uniqueHumanSeats: 1,
      baselineMemberCount: 1, evidenceIds: ['interval-1'], currency: 'USD' });
    expect(quote.intervals).toHaveLength(1);
  });

  it('holds an uncaptured zero-seat baseline instead of silently quoting zero', async () => {
    const source = stripeSource();
    source.seatSubscription.baselineMemberCount = null as never;
    source.seatSubscription.membershipIntervals = [];
    const prisma = { billingStripeSubscription: { findUnique: vi.fn().mockResolvedValue(source) } };
    await expect(quoteSubscriptionMonthlyCharge({ source: { kind: 'stripe', id: source.id },
      billingMonth: '2028-02' }, closed(prisma)))
      .rejects.toThrow('BILLING_SEAT_EVIDENCE_UNRESOLVED');
  });

  it('keeps a legacy flat manual term at one monthly amount and rejects a superseded term', async () => {
    const term = { id: 'term-1', serviceId: 'service-1', tariffId: 'tariff-1',
      contractVersionId: 'version-1', monthlyAmountMinor: 1200n,
      tariff: { monthlyChargeBasis: BillingMonthlyChargeBasis.FLAT,
        seatPolicy: null, seatChargeTiming: null,
        monthlyAmountMinor: 1200n, currency: 'USD' },
      contractVersion: { contractId: 'contract-1', currency: 'USD',
        contract: { orgId: 'org-1', terminatedAt: null } }, seatSubscription: null };
    const effective = vi.fn().mockResolvedValue({ id: 'version-1' });
    const prisma = { billingContractServiceTerm: { findUnique: vi.fn().mockResolvedValue(term) },
      billingOrganisationContractVersion: { findFirst: effective } };
    const quote = await quoteSubscriptionMonthlyCharge({ source: { kind: 'manual', id: term.id },
      billingMonth: '2028-02' }, closed(prisma));
    expect(quote).toMatchObject({ amountMinor: 1200n,
      agreementId: null, evidenceIds: [], scope: BillingAssignmentScope.ORGANISATION });
    effective.mockResolvedValue({ id: 'version-2' });
    await expect(quoteSubscriptionMonthlyCharge({ source: { kind: 'manual', id: term.id },
      billingMonth: '2028-03' }, closed(prisma)))
      .rejects.toThrow('BILLING_MONTHLY_SOURCE_NOT_EFFECTIVE');
  });

  it('quotes flat Stripe only after observed activation and before termination', async () => {
    const source = { ...stripeSource(), tariff: {
      monthlyChargeBasis: BillingMonthlyChargeBasis.FLAT, seatPolicy: null,
      seatChargeTiming: null, monthlyAmountMinor: 1200n, currency: 'USD' },
    seatSubscription: null, billableFrom: at('2028-01-25T12:00:00Z'),
    billableUntil: at('2028-03-15T00:00:00Z') };
    const prisma = { billingStripeSubscription: { findUnique: vi.fn().mockResolvedValue(source) } };
    const quote = (month: string) => quoteSubscriptionMonthlyCharge({
      source: { kind: 'stripe', id: source.id }, billingMonth: month,
    }, closed(prisma));
    await expect(quote('2028-01')).rejects.toThrow('BILLING_MONTHLY_SOURCE_NOT_EFFECTIVE');
    await expect(quote('2028-02')).resolves.toMatchObject({ amountMinor: 1200n });
    await expect(quote('2028-04')).rejects.toThrow('BILLING_MONTHLY_SOURCE_NOT_EFFECTIVE');
    source.billableFrom = null as never;
    await expect(quote('2028-02')).rejects.toThrow('BILLING_MONTHLY_SOURCE_NOT_EFFECTIVE');
  });
});
