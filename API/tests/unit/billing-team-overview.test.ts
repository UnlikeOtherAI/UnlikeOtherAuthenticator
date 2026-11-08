import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { OrganisationBillingContext } from '../../src/services/billing-organisation-authority.service.js';
const mocks = vi.hoisted(() => ({ authority: vi.fn(), usage: vi.fn(), retained: vi.fn() }));
vi.mock('../../src/services/billing-organisation-authority.service.js', () => ({ authorizeOrganisationBilling: mocks.authority }));
vi.mock('../../src/services/billing-team-records.service.js', () => ({ readTeamRecordedUsage: mocks.usage,
  readTeamRetainedCredits: mocks.retained }));
import { billingTeamOverview } from '../../src/services/billing-team-overview.service.js';
const context = { request: { product: 'nessie', organisationId: 'org', teamId: 'team', userId: 'admin' },
  credential: { service: { id: 'service', identifier: 'nessie', name: 'Nessie' } }, endpoint: '/billing/v1/team/overview' } as OrganisationBillingContext;
const team = vi.fn().mockResolvedValue({ id: 'team', name: 'Selected team' });
const transaction = vi.fn(async (read: (tx: unknown) => Promise<unknown>) => read({}));
const deps = { prisma: { team: { findFirst: team }, $transaction: transaction } as unknown as PrismaClient,
  now: new Date('2026-11-08T00:00:00Z'), metering: vi.fn(async () => ({ calls: '12', snapshot: { capturedAt: '2026-11-08T00:00:00Z' } })) as never,
  proof: vi.fn(async () => ({})) as never };
beforeEach(() => { vi.clearAllMocks(); mocks.authority.mockResolvedValue({ billingManager: false, teamRole: 'admin' });
  mocks.usage.mockResolvedValue({ as_of: deps.now.toISOString(), sources: [] });
  mocks.retained.mockResolvedValue({ as_of: deps.now.toISOString(), records: [] }); });
describe('own-team read-only overview publication', () => {
  it('keeps independent retained records when metering fails, with no numeric unavailable usage', async () => {
    const value = await billingTeamOverview(context, {}, { ...deps, metering: async () => { throw Error('UNAVAILABLE'); } });
    expect(value.sections.activity.state).toBe('unavailable');
    expect(value.sections.recorded_credit_usage).not.toHaveProperty('data');
    expect(value.sections.retained_credits.state).toBe('confirmed');
    expect(value).not.toHaveProperty('financial_scope');expect(value).not.toHaveProperty('actions');
  });
  it('refuses a response after selected-team admin role loss, even after successful dependency reads', async () => {
    mocks.authority.mockResolvedValueOnce({ billingManager: false, teamRole: 'admin' })
      .mockResolvedValueOnce({ billingManager: false, teamRole: 'member' });
    await expect(billingTeamOverview(context, {}, deps)).rejects.toThrow('BILLING_TEAM_ACCESS_REQUIRED');
    expect(mocks.retained).toHaveBeenCalledOnce();
  });
  it('rejects another-team admin or null selected team before touching record sources', async () => {
    mocks.authority.mockResolvedValue({ billingManager: false, teamRole: 'member', otherTeamRole: 'admin' });
    await expect(billingTeamOverview(context, {}, deps)).rejects.toThrow('BILLING_TEAM_ACCESS_REQUIRED');
    mocks.authority.mockResolvedValue({ billingManager: true, teamRole: '' });
    await expect(billingTeamOverview({ ...context, request: { ...context.request, teamId: null } }, {}, deps))
      .rejects.toThrow('BILLING_TEAM_ACCESS_REQUIRED');
    expect(mocks.retained).not.toHaveBeenCalled();
  });
  it('keeps recorded calls and canonical copy localized in every source locale', async () => {
    for (const locale of ['cs', 'en-US', 'en-GB', 'de', 'es', 'fr', 'it'] as const) {
      const value = await billingTeamOverview(context, { locale }, deps);
      expect(value.sections.activity).toMatchObject({ state: 'confirmed', data: { recorded_calls: { quantity: '12' } } });
      expect(value.description).toBeTruthy();expect(value.sections.retained_credits.message).toBeTruthy();
    }
  });
});
