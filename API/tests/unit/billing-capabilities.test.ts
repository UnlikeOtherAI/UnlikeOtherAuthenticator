import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authority: vi.fn(), mode: vi.fn() }));
vi.mock('../../src/services/billing-organisation-authority.service.js', () => ({ authorizeOrganisationBilling: mocks.authority }));
vi.mock('../../src/services/billing-organisation-mode.service.js', () => ({ resolveOrganisationBillingMode: mocks.mode }));
import { billingCapabilities } from '../../src/services/billing-capabilities.service.js';
import type { OrganisationBillingContext } from '../../src/services/billing-organisation-authority.service.js';
const context = { request: { product: 'nessie', organisationId: 'org', teamId: 'selected', userId: 'actor' },
  endpoint: '/billing/v1/organisation/capabilities' } as OrganisationBillingContext;
const deps = { prisma: {} as PrismaClient };
beforeEach(() => { vi.clearAllMocks(); mocks.mode.mockResolvedValue({ mode: 'live', revision: 0, epoch: '2026-11-08T00:00:00Z' }); });
describe('current financial manager or selected-team reader capability', () => {
  it('publishes Org financial scope only for a current organisation manager', async () => {
    mocks.authority.mockResolvedValue({ billingManager: true, teamRole: '' });
    expect(await billingCapabilities(context, deps)).toMatchObject({ access: 'organisation_manager', financial_scope: { mode: 'live' } });
    expect(mocks.mode).toHaveBeenCalledOnce();
  });
  it('allows own selected-team owner/admin records without resolving the financial mode', async () => {
    for (const teamRole of ['owner', 'admin']) {
      mocks.authority.mockResolvedValue({ billingManager: false, teamRole });
      const value = await billingCapabilities(context, deps);
      expect(value).toMatchObject({ access: 'team_reader', team_scope: { team_id: 'selected' },
        overview_request: { method: 'POST', path: '/billing/v1/team/overview', body: { team_id: 'selected' } } });
      expect(value).not.toHaveProperty('financial_scope');
    }
    expect(mocks.mode).not.toHaveBeenCalled();
  });
  it('grants neither Org money nor team records to a member, even with other-team authority', async () => {
    mocks.authority.mockResolvedValue({ billingManager: false, teamRole: 'member', otherTeamRole: 'admin' });
    const value = await billingCapabilities(context, deps);
    expect(value.access).toBe('none');expect(value).not.toHaveProperty('financial_scope');
    expect(value).not.toHaveProperty('team_scope');expect(mocks.mode).not.toHaveBeenCalled();
  });
});
