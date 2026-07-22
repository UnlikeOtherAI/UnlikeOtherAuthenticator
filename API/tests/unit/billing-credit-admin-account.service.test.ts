import { BillingCreditAutoTopUpState } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { listAdminCreditAccounts } from '../../src/services/billing-credit-admin-account.service.js';

function row(id: string, updatedAt: string) {
  return {
    id,
    accountId: `billing_${id}`,
    orgId: `org_${id}`,
    teamId: `team_${id}`,
    currency: 'USD',
    balanceMicrocredits: 10_000_000n,
    autoTopUpGeneration: 0,
    autoTopUpState: BillingCreditAutoTopUpState.DISABLED,
    autoTopUpThresholdMicrocredits: null,
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
    account: { livemode: false },
    org: { id: `org_${id}`, name: 'Exact Org' },
    team: { id: `team_${id}`, name: 'Exact Team' },
    autoTopUpConsentRevision: null,
    adminAdjustments: [],
  };
}

describe('admin credit account pagination', () => {
  it('uses an immutable createdAt/id cursor and reports loaded pages without inventing a total', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([
        row('credit_3', '2026-07-21T12:03:00.000Z'),
        row('credit_2', '2026-07-21T12:02:00.000Z'),
        row('credit_1', '2026-07-21T12:01:00.000Z'),
      ])
      .mockResolvedValueOnce([row('credit_1', '2026-07-21T12:01:00.000Z')]);
    const prisma = { billingCreditAccount: { findMany } } as never;

    const first = await listAdminCreditAccounts({ search: 'Exact Team', limit: 2 }, { prisma });
    expect(first).toMatchObject({
      has_more: true,
      accounts: [{ id: 'credit_3' }, { id: 'credit_2' }],
    });
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(findMany.mock.calls[0][0]).toMatchObject({
      take: 3,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      where: {
        currency: 'USD',
        AND: [
          {
            OR: expect.arrayContaining([
              { id: 'Exact Team' },
              { orgId: 'Exact Team' },
              { teamId: 'Exact Team' },
            ]),
          },
        ],
      },
    });

    const second = await listAdminCreditAccounts(
      { search: 'Exact Team', cursor: first.next_cursor!, limit: 2 },
      { prisma },
    );
    expect(second).toMatchObject({
      has_more: false,
      next_cursor: null,
      accounts: [{ id: 'credit_1' }],
    });
    expect(findMany.mock.calls[1][0].where.AND[1]).toEqual({
      OR: [
        { createdAt: { lt: new Date('2026-07-21T12:02:00.000Z') } },
        {
          createdAt: new Date('2026-07-21T12:02:00.000Z'),
          id: { lt: 'credit_2' },
        },
      ],
    });
  });

  it('rejects a cursor reused with a different exact search', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        row('credit_2', '2026-07-21T12:02:00.000Z'),
        row('credit_1', '2026-07-21T12:01:00.000Z'),
      ]);
    const prisma = { billingCreditAccount: { findMany } } as never;
    const first = await listAdminCreditAccounts({ search: 'Exact Team', limit: 1 }, { prisma });

    await expect(
      listAdminCreditAccounts(
        { search: 'Another Team', cursor: first.next_cursor!, limit: 1 },
        { prisma },
      ),
    ).rejects.toThrowError('BILLING_CREDIT_ACCOUNT_CURSOR_INVALID');
  });

  it('rejects a cursor reused with different organisation or team filters', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        row('credit_2', '2026-07-21T12:02:00.000Z'),
        row('credit_1', '2026-07-21T12:01:00.000Z'),
      ]);
    const prisma = { billingCreditAccount: { findMany } } as never;
    const first = await listAdminCreditAccounts(
      {
        organisationId: 'org_exact',
        teamId: 'team_exact',
        search: 'Exact Team',
        limit: 1,
      },
      { prisma },
    );

    await expect(
      listAdminCreditAccounts(
        {
          organisationId: 'org_other',
          teamId: 'team_exact',
          search: 'Exact Team',
          cursor: first.next_cursor!,
          limit: 1,
        },
        { prisma },
      ),
    ).rejects.toThrowError('BILLING_CREDIT_ACCOUNT_CURSOR_INVALID');
    await expect(
      listAdminCreditAccounts(
        {
          organisationId: 'org_exact',
          teamId: 'team_other',
          search: 'Exact Team',
          cursor: first.next_cursor!,
          limit: 1,
        },
        { prisma },
      ),
    ).rejects.toThrowError('BILLING_CREDIT_ACCOUNT_CURSOR_INVALID');
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
