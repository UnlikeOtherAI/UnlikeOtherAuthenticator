import { BillingAssignmentScope } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { assertUnambiguousCreditPayer } from '../../src/services/billing-credit-payer-period.service.js';

const when = (iso: string) => new Date(iso);

describe('dated credit payer lineage', () => {
  it('keeps older organisation months with the organisation after release and re-assumption', async () => {
    const prisma = { billingOrgResponsibility: { findUnique: vi.fn().mockResolvedValue({
      createdAt: when('2026-01-15T12:00:00.000Z'),
      transitions: [
        { kind: 'ASSUMED', effectiveAt: when('2026-01-15T12:00:00.000Z') },
        { kind: 'RELEASED', effectiveAt: when('2026-03-20T12:00:00.000Z') },
        { kind: 'ASSUMED', effectiveAt: when('2026-05-10T12:00:00.000Z') },
      ],
    }) } };
    const check = (billingMonth: string, scope: BillingAssignmentScope) =>
      assertUnambiguousCreditPayer(prisma as never, { orgId: 'org_1', billingMonth, scope });
    await expect(check('2026-02', BillingAssignmentScope.ORGANISATION)).resolves.toBeUndefined();
    await expect(check('2026-04', BillingAssignmentScope.TEAM)).resolves.toBeUndefined();
    await expect(check('2026-06', BillingAssignmentScope.ORGANISATION)).resolves.toBeUndefined();
    await expect(check('2026-02', BillingAssignmentScope.TEAM))
      .rejects.toThrow('BILLING_CREDIT_HISTORICAL_PAYER_MISMATCH');
    await expect(check('2026-05', BillingAssignmentScope.ORGANISATION))
      .rejects.toThrow('BILLING_CREDIT_PAYER_TRANSITION_RECONCILIATION_REQUIRED');
  });

  it('holds legacy prehistory when an old mutable responsibility row lost earlier intervals', async () => {
    const prisma = { billingOrgResponsibility: { findUnique: vi.fn().mockResolvedValue({
      createdAt: when('2026-01-15T12:00:00.000Z'),
      transitions: [{ kind: 'ASSUMED', effectiveAt: when('2026-05-10T12:00:00.000Z') }],
    }) } };
    await expect(assertUnambiguousCreditPayer(prisma as never, {
      orgId: 'org_1', billingMonth: '2026-02', scope: BillingAssignmentScope.TEAM,
    })).rejects.toThrow('BILLING_CREDIT_PAYER_PREHISTORY_UNCERTAIN');
  });
});
