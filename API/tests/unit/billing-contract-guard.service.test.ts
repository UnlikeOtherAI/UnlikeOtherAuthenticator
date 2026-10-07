import { describe, expect, it, vi } from 'vitest';

import {
  assertContractAssignmentRemovalAllowed,
  assertContractAssignmentWriteAllowed,
} from '../../src/services/billing-contract-guard.service.js';

function client(currentTerm: { id: string } | null) {
  return {
    billingOrganisationContract: {
      findMany: vi.fn().mockResolvedValue([{
        versions: [{ effectiveFromMonth: '2020-01',
          serviceTerms: currentTerm ? [currentTerm] : [] }],
      }]),
    },
    billingTariffAssignment: {
      findUnique: vi.fn().mockResolvedValue({ serviceId: 'service_1', orgId: 'org_1' }),
    },
  };
}

describe('active contract tariff assignment guard', () => {
  it('blocks both organisation and team overrides for a current contract service', async () => {
    for (const teamId of [null, 'team_1']) {
      await expect(
        assertContractAssignmentWriteAllowed(client({ id: 'term_1' }) as never, {
          serviceId: 'service_1',
          organisationId: 'org_1',
          teamId,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    }
  });

  it('protects only the current version pointer and releases a removed service assignment', async () => {
    await expect(
      assertContractAssignmentRemovalAllowed(client({ id: 'term_1' }) as never, 'assignment_1'),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'BILLING_CONTRACT_ASSIGNMENT_LOCKED',
    });
    await expect(
      assertContractAssignmentRemovalAllowed(client(null) as never, 'assignment_1'),
    ).resolves.toBeUndefined();
  });

  it('keeps the old service protected until a scheduled version drops it', async () => {
    const tx = client(null);
    tx.billingOrganisationContract.findMany.mockResolvedValueOnce([{
      versions: [
        { effectiveFromMonth: '9999-01', serviceTerms: [] },
        { effectiveFromMonth: '2020-01', serviceTerms: [{ id: 'old' }] },
      ],
    }]);
    await expect(assertContractAssignmentRemovalAllowed(tx as never, 'assignment_1'))
      .rejects.toThrow('BILLING_CONTRACT_ASSIGNMENT_LOCKED');
  });
});
