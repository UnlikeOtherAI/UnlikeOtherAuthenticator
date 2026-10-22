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
    billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
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
        billingDisposition: 'paid',
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
        { id: 'team_a', name: 'Research', lifecycleStatus: 'DISABLED' },
        { id: 'team_b', name: 'Deleted team team_b', lifecycleStatus: 'DELETED' },
      ]),
    },
    billingService: {
      findUnique: vi.fn().mockResolvedValue({ tariffHistoryFromMonth: '2026-07' }),
    },
    billingOrganisationContractVersion: { findMany: vi.fn().mockResolvedValue([]) },
    billingTariffTermEvent: {
      findFirst: vi.fn(async ({ where }: { where: { source: string } }) =>
        where.source === 'SERVICE_DEFAULT' ? { tariffId: 'tariff_standard', assignmentId: null, tariff: {
        id: 'tariff_standard',
        serviceId: 'service_deepwater',
        key: 'standard',
        name: 'Standard',
        version: 1,
        mode: 'STANDARD',
        markupBps: 2_000,
        monthlyAmountMinor: 1_000n,
        currency: 'USD',
      } } : null),
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
  it('uses one selected locale for controlled-by copy and preserves the organisation name', () => {
    const manager = buildBillingControlledBy({
      organisationId: 'org_1',
      organisationName: 'Acme Research',
      canManage: true,
      locale: 'cs',
    });

    expect(manager.organisation_name).toBe('Acme Research');
    expect(manager.message).toContain('Fakturaci tohoto týmu');
    expect(manager.message).toContain('Acme Research');
    expect(manager.message).not.toContain('Billing for this team');
  });

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

  it('includes suspended and retained deleted teams from their pinned snapshots', async () => {
    const prisma = prismaDouble();
    const fetchPortfolio = vi.fn(async (params: { teamId: string }) =>
      portfolio(params.teamId, params.teamId === 'team_a' ? '2' : '3', 'user_1'),
    );

    const scope = await buildOrganisationStatementScope(context, {
      prisma: prisma as never,
      fetchPortfolio: fetchPortfolio as never,
    });

    expect(fetchPortfolio).toHaveBeenCalledTimes(2);
    expect(prisma.team.findMany).toHaveBeenCalledWith({
      where: { orgId: context.organisationId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    expect(fetchPortfolio.mock.calls.map(([params]) => params)).toEqual([
      { product: 'deepwater', organisationId: 'org_1', teamId: 'team_a',
        billingMonth: '2026-07', groupBy: 'user' },
      { product: 'deepwater', organisationId: 'org_1', teamId: 'team_b',
        billingMonth: '2026-07', groupBy: 'user' },
    ]);
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

  it('keeps zero-usage teams visible and fails the whole roll-up if any team cannot be collected', async () => {
    const prisma = prismaDouble();
    prisma.team.findMany.mockResolvedValue([
      { id: 'team_a', name: 'Research', lifecycleStatus: 'DISABLED' },
      { id: 'team_b', name: 'Deleted team team_b', lifecycleStatus: 'DELETED' },
      { id: 'team_empty', name: 'Unused', lifecycleStatus: 'ACTIVE' },
    ]);
    const fetchPortfolio = vi.fn(async ({ teamId }: { teamId: string }) => {
      const value = portfolio(teamId, teamId === 'team_a' ? '2' : '3', 'user_1');
      return teamId === 'team_empty' ? { ...value, calls: '0', lines: [] } : value;
    });
    const scope = await buildOrganisationStatementScope(context, {
      prisma: prisma as never, fetchPortfolio: fetchPortfolio as never,
    });
    expect(fetchPortfolio).toHaveBeenCalledTimes(3);
    expect(scope.teams.map((team) => team.team_id)).toEqual(['team_a', 'team_b', 'team_empty']);
    expect(scope.teams[2]?.commercial_lines.filter((line) => line.kind === 'usage')).toEqual([]);
    expect(scope.totals[0]?.total_due.amount).toBe('36');

    fetchPortfolio.mockImplementation(async ({ teamId }) => {
      if (teamId === 'team_b') throw new Error('LEDGER_METERING_PORTFOLIO_REQUEST_FAILED');
      return portfolio(teamId, '2', 'user_1');
    });
    await expect(buildOrganisationStatementScope(context, {
      prisma: prisma as never, fetchPortfolio: fetchPortfolio as never,
    })).rejects.toThrow('LEDGER_METERING_PORTFOLIO_REQUEST_FAILED');
  });
});
