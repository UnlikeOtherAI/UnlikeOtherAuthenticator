import { describe, expect, it, vi } from 'vitest';

import { buildBillingControlledBy } from '../../src/services/billing-org-responsibility.service.js';
import { buildOrganisationStatementScope } from '../../src/services/billing-statement-organisation.service.js';
import type { NormalizedMeteringPortfolio } from '../../src/services/billing-metering.types.js';
import { addBillingDecimals } from '../../src/services/billing-money.service.js';

const context = {
  organisationId: 'org_1',
  serviceId: 'service_deepwater',
  statementProduct: 'deepwater',
  billingMonth: '2026-07',
  periodStartsAt: new Date('2026-07-01T00:00:00.000Z'),
  periodEndsAt: new Date('2026-08-01T00:00:00.000Z'),
  products: [{ identifier: 'deepwater', name: 'DeepWater' }],
};

function portfolio(teamId: string, cost: string, userId: string): NormalizedMeteringPortfolio {
  return {
    schemaVersion: 1,
    contract: 'metering-portfolio-v1',
    perspectiveProduct: 'deepwater',
    groupBy: 'user',
    scope: {
      organizationId: 'org_1',
      teamId,
      month: '2026-07',
      startsAt: '2026-07-01T00:00:00.000Z',
      endsAt: '2026-08-01T00:00:00.000Z',
    },
    calls: '1',
    lines: [
      {
        serviceId: 'openai',
        usageUnit: 'tokens',
        calls: '1',
        inputUnits: '100',
        cachedInputUnits: '0',
        outputUnits: '50',
        estimatedProviderCost: cost,
        actualProviderCost: cost,
        selectedProviderCost: cost,
        currency: 'USD',
        costProvenance: 'provider_invoice',
        billingProduct: 'deepwater',
        callerProduct: 'deepwater',
        originProduct: 'deepwater',
        userId,
      },
    ],
    snapshot: {
      id: `mus_${teamId}`,
      cursor: `mus_${teamId}`,
      capturedAt: '2026-07-20T11:59:00.000Z',
      immutable: true,
      sha256: teamId === 'team_a' ? 'a'.repeat(64) : 'b'.repeat(64),
    },
  };
}

function prismaDouble() {
  return {
    organisation: {
      findUnique: vi.fn().mockResolvedValue({ id: 'org_1', name: 'Acme' }),
    },
    team: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'team_a', name: 'Research' },
        { id: 'team_b', name: 'Support' },
      ]),
    },
    billingTariffAssignment: { findFirst: vi.fn().mockResolvedValue(null) },
    billingTariff: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'tariff_standard',
        key: 'standard',
        name: 'Standard',
        version: 1,
        mode: 'STANDARD',
        markupBps: 2_000,
        monthlyAmountMinor: 1_000n,
        currency: 'USD',
      }),
    },
    teamMember: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ user: { id: 'user_1', name: 'Ada', email: 'ada@example.com' } }]),
    },
    billingCommercialAdjustment: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

describe('organisation billing responsibility', () => {
  it('composes the controlled-by copy in UOA, and names an action only for a manager', () => {
    const manager = buildBillingControlledBy({
      organisationId: 'org_1',
      organisationName: 'Acme',
      canManage: true,
    });
    const member = buildBillingControlledBy({
      organisationId: 'org_1',
      organisationName: 'Acme',
      canManage: false,
    });

    expect(manager).toMatchObject({
      scope: 'organisation',
      organisation_id: 'org_1',
      organisation_name: 'Acme',
      can_manage: true,
      manage_action_id: 'org-billing-open',
    });
    expect(manager.message).toContain('Acme');
    expect(member.manage_action_id).toBeNull();
    expect(member.message).toContain('Acme');
    expect(member.message).not.toContain('Open organisation billing');
  });

  it('rolls every team up from its own pinned snapshot, with totals equal to the sum', async () => {
    const prisma = prismaDouble();
    const fetchPortfolio = vi.fn(async (params: { teamId: string }) =>
      portfolio(params.teamId, params.teamId === 'team_a' ? '2' : '3', 'user_1'),
    );

    const scope = await buildOrganisationStatementScope(context, {
      prisma: prisma as never,
      fetchPortfolio: fetchPortfolio as never,
      listDirectAccess: vi.fn().mockResolvedValue([]) as never,
    });

    expect(fetchPortfolio).toHaveBeenCalledTimes(2);
    expect(scope.teams.map((team) => team.team_id)).toEqual(['team_a', 'team_b']);
    // Each team is pinned to its own Ledger snapshot; nothing is merged before
    // rating.
    expect(scope.teams.map((team) => team.pinned_ledger_snapshot.id)).toEqual([
      'mus_team_a',
      'mus_team_b',
    ]);

    // The organisation total is the sum of the team totals, by construction:
    // the same summation, over every team's lines.
    for (const currency of ['USD']) {
      const organisationTotal = scope.totals.find((total) => total.currency === currency);
      const summed = scope.teams
        .map(
          (team) =>
            team.totals.find((total) => total.currency === currency)?.total_due.amount ?? '0',
        )
        .reduce(addBillingDecimals, '0');
      expect(organisationTotal?.total_due.amount).toBe(summed);
    }
    expect(scope.commercial_lines.length).toBe(
      scope.teams.reduce((count, team) => count + team.commercial_lines.length, 0),
    );
  });
});
