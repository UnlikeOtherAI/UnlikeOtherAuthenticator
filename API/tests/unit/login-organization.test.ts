import { describe, expect, it, vi } from 'vitest';
import { validateConfigFields } from '../../src/services/config.service.js';
import { assertLoginOrganization } from '../../src/services/login-organization.service.js';
import { buildSessionChoices, resolveAutoSelectedTeam, shouldPresentTeamChooser } from '../../src/services/session-choices.service.js';
import { signLoginSession, verifyLoginSession } from '../../src/services/login-session.service.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

const config = (organizationId?: string) => validateConfigFields({ ...baseClientConfigPayload(),
  login_flow: { team_selection: 'auto', ...(organizationId ? { organization_id: organizationId } : {}) },
  org_features: { enabled: true, allow_user_create_org: true, allow_user_create_team: true },
});
const rows = ['acme', 'other'].flatMap(orgId => [1, 2].map(n => ({ teamId: `${orgId}-${n}`, teamRole: 'member',
  team: { orgId, name: `Team ${n}`, slug: `team-${n}`, iconUrl: null, updatedAt: new Date(), org: { name: orgId } },
})));
function directory() {
  const teamMember = { findMany: vi.fn(async ({ where }) => rows.filter(row => !where.team.orgId || row.team.orgId === where.team.orgId)) };
  const orgMember = { findMany: vi.fn(async ({ where }) => ['acme', 'other']
    .filter(orgId => !where.orgId || orgId === where.orgId).map(orgId => ({ orgId, role: 'owner', org: { name: orgId } }))) };
  const teamInvite = { findMany: vi.fn(async ({ where }) => ['acme', 'other']
    .filter(orgId => !where.orgId || orgId === where.orgId).map(orgId => ({ id: `invite-${orgId}`, team: { name: orgId }, org: { name: orgId }, invitedByName: 'Jo', invitedByUserId: null }))) };
  return { user: { findUnique: vi.fn(async () => ({ email: 'member@example.com' })), findMany: vi.fn(async () => []) },
    teamMember, orgMember, teamInvite };
}

describe('organisation-scoped sign-in', () => {
  it('filters every chooser destination across product domains before selection', async () => {
    const prisma = directory();
    const choices = await buildSessionChoices({ userId: 'member', config: config('acme') },
      { prisma, crossProductPrisma: prisma, policy: { scope: 'all_active_memberships', serviceId: 'nessie', product: 'nessie' } });
    expect(choices.teams.map(t => t.teamId)).toEqual(['acme-1', 'acme-2']);
    expect(choices.pending_invites.map(i => i.inviteId)).toEqual(['invite-acme']);
    expect(choices.creatable_orgs.map(o => o.orgId)).toEqual(['acme']);
    expect(choices.manageable_orgs?.map(o => o.orgId)).toEqual(['acme']);
    expect(choices.can_create_org).toBe(false);
    expect(resolveAutoSelectedTeam(choices)).toBeNull();
  });
  it('keeps an empty scoped chooser instead of selecting another org or creating a personal org', async () => {
    const prisma = directory();
    const choices = await buildSessionChoices({ userId: 'member', config: config('missing') },
      { prisma, crossProductPrisma: prisma, policy: { scope: 'all_active_memberships', serviceId: 'nessie', product: 'nessie' } });
    expect(choices).toMatchObject({ teams: [], pending_invites: [], creatable_orgs: [], can_create_org: false });
    expect(shouldPresentTeamChooser(choices)).toBe(true);
  });
  it('preserves the ordinary all-organisation chooser', async () => {
    const prisma = directory();
    const choices = await buildSessionChoices({ userId: 'member', config: config() },
      { prisma, crossProductPrisma: prisma, policy: { scope: 'all_active_memberships', serviceId: 'nessie', product: 'nessie' } });
    expect(choices.teams).toHaveLength(4);
    expect(choices.can_create_org).toBe(true);
    expect(choices.organization_id).toBeUndefined();
  });
  it('requires the exact organization on a selection or creation continuation', () => {
    expect(() => assertLoginOrganization(config('acme'), 'acme')).not.toThrow();
    for (const org of [undefined, 'other']) expect(() => assertLoginOrganization(config('acme'), org)).toThrow();
    expect(() => assertLoginOrganization(config(), 'other')).not.toThrow();
  });
  it('binds the organization into the signed chooser capability across reload/social continuations', async () => {
    const params = { userId: 'member', credentialEpoch: 0, authMethod: 'google', config: config('acme'),
      configUrl: 'https://client.example.com/config?organizationId=acme', redirectUrl: 'https://client.example.com/callback',
      rememberMe: false, requestAccess: false, sharedSecret: 'test-secret-that-is-long-enough', audience: 'uoa:login-session' };
    const token = await signLoginSession(params);
    await expect(verifyLoginSession({ ...params, token })).resolves.toMatchObject({ authMethod: 'google' });
    for (const changed of [config(), config('other')]) {
      await expect(verifyLoginSession({ ...params, config: changed, token })).rejects.toMatchObject({ statusCode: 401 });
    }
  });
});
