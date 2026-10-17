import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRlsTestDb, type RlsTestDbHandle } from '../helpers/test-db.js';
import { replaceManagedMemberships, withdrawConnectionMemberships } from '../../src/services/membership-provenance.service.js';
import { lockEnterpriseOutbox } from '../../src/services/org-sso-revocation.service.js';
import { admitEnterpriseIdentity } from '../../src/services/org-sso-admission.service.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { fingerprintClientConfig } from '../../src/services/client-config-fingerprint.service.js';
import { buildSessionChoices } from '../../src/services/first-login.service.js';
import { assertIndependentChooserMutation } from '../../src/services/authentication-evidence.service.js';

describe('managed membership sources with real PostgreSQL', () => {
  let handle: RlsTestDbHandle;
  let db: PrismaClient;
  const suffix = randomUUID();
  const owner = `owner-${suffix}`;
  const user = `user-${suffix}`;
  const org = `org-${suffix}`;
  const team = `team-${suffix}`;
  const domain = `source-${suffix}.example.com`;
  let connection: string;
  beforeAll(async () => {
    const created = await createRlsTestDb();
    if (!created) throw new Error('DATABASE_URL required for real source provenance coverage');
    handle = created;
    db = new PrismaClient({ datasources: { db: { url: handle.adminDatabaseUrl } } });
    await db.$connect();
    await db.clientDomain.create({ data: { domain, label: 'Source test' } });
    await db.user.createMany({ data: [{ id: owner, userKey: owner, email: `${owner}@example.com` },
      { id: user, userKey: user, email: `${user}@example.com` }] });
    await db.organisation.create({ data: { id: org, name: 'Source test', slug: org, domain, ownerId: owner } });
    await db.orgMember.create({ data: { orgId: org, userId: owner, role: 'owner' } });
    await db.team.create({ data: { id: team, orgId: org, name: 'Source team', slug: team } });
    await db.orgSsoPolicy.create({ data: { orgId: org, clientDomain: domain } });
    const row = await db.orgSsoConnection.create({ data: { orgId: org, clientDomain: domain,
      preset: 'other_oidc', protocol: 'oidc', displayName: 'Source test', configuration: {} } });
    connection = row.id;
  });
  afterAll(async () => { await db?.$disconnect(); await handle?.cleanup(); });

  it('aggregates sources without turning aggregate writes into manual authority', async () => {
    await db.$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      await replaceManagedMemberships({ userId: user, orgId: org, clientDomain: domain,
        connectionId: connection, sourceKind: 'sso', sourceId: 'identity', grants: [
          { teamId: null, role: 'member', resourceId: 'identity' }, { teamId: team, role: 'admin', resourceId: 'signed-group' },
        ] }, tx);
    });
    expect(await db.membershipContribution.count({ where: { userId: user, sourceKind: 'manual' } })).toBe(0);
    expect((await db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: team, userId: user } } })).teamRole).toBe('admin');
    await db.$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      await replaceManagedMemberships({ userId: user, orgId: org, clientDomain: domain,
        connectionId: connection, sourceKind: 'scim', sourceId: 'provisioning', grants: [
          { teamId: null, role: 'member', resourceId: 'resource' }, { teamId: team, role: 'member', resourceId: 'group' },
        ] }, tx);
      await withdrawConnectionMemberships({ connectionId: connection, sourceKind: 'sso', sourceId: 'identity' }, tx);
    });
    expect((await db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: team, userId: user } } })).teamRole).toBe('member');
    expect((await db.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: org, userId: user } } })).status).toBe('ACTIVE');
  });

  it('keeps a manual grant after provisioning is withdrawn and refuses manual removal resurrection', async () => {
    await db.teamMember.update({ where: { teamId_userId: { teamId: team, userId: user } }, data: { teamRole: 'admin' } });
    await db.orgMember.update({ where: { orgId_userId: { orgId: org, userId: user } }, data: { role: 'member' } });
    await db.$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      await withdrawConnectionMemberships({ connectionId: connection, sourceKind: 'scim' }, tx);
    });
    expect((await db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: team, userId: user } } })).status).toBe('ACTIVE');
    await db.teamMember.update({ where: { teamId_userId: { teamId: team, userId: user } }, data: { status: 'REMOVED' } });
    await expect(db.$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      return replaceManagedMemberships({ userId: user, orgId: org, clientDomain: domain,
        connectionId: connection, sourceKind: 'sso', sourceId: 'identity', grants: [
          { teamId: team, role: 'member', resourceId: 'signed-group' },
        ] }, tx);
    })).rejects.toThrow('SSO_MEMBERSHIP_SUPPRESSED');
    expect((await db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: team, userId: user } } })).status).toBe('REMOVED');
  });

  it('cannot map owner authority or bind a contribution to a foreign organisation team', async () => {
    await expect(db.membershipContribution.create({ data: { userId: user, orgId: org, scopeKey: 'org',
      sourceKind: 'sso', sourceId: 'bad', connectionId: connection, clientDomain: domain, role: 'owner' } })).rejects.toThrow();
    const foreign = await db.organisation.create({ data: { domain, ownerId: owner, name: 'Other', slug: `other-${suffix}` } });
    const foreignTeam = await db.team.create({ data: { orgId: foreign.id, name: 'Other', slug: 'other' } });
    await expect(db.membershipContribution.create({ data: { userId: user, orgId: org, teamId: foreignTeam.id,
      scopeKey: foreignTeam.id, sourceKind: 'manual', sourceId: 'bad', role: 'member' } })).rejects.toThrow();
  });

  it('never links an existing email and JIT creates only a scoped passwordless identity', async () => {
    const config = { domain, user_scope: 'global', redirect_urls: [`https://${domain}/callback`] } as ClientConfig;
    const policy = await db.orgSsoPolicy.update({ where: { clientDomain_orgId: { clientDomain: domain, orgId: org } },
      data: { arrangementEnabled: true, jitEnabled: true, defaultTeamId: team } });
    const provider = await db.orgSsoConnection.update({ where: { id: connection }, data: { status: 'active', testedRevision: 1 } });
    const context = { config_url: `https://${domain}/config`, config_fingerprint: fingerprintClientConfig(config), client_domain: domain,
      redirect_url: `https://${domain}/callback`, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' as const,
      state: 'rp-state', policy_generation: policy.generation };
    const identity = { issuer: 'https://issuer.example.com', tenant: 'exact-tenant', subject: 'stable-existing',
      email: `${user}@example.com`, emailVerified: true, groups: [], authenticatedAt: null,
      observedAt: new Date(), sessionExpiresAt: new Date(Date.now() + 3600000), amr: ['upstream'] };
    const pending = await db.$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      return admitEnterpriseIdentity({ connection: provider, policy, identity, config, context }, tx);
    });
    expect(pending.kind).toBe('link_required');
    expect(await db.externalIdentity.count({ where: { connectionId: connection } })).toBe(0);
    await db.organisationEmailDomain.create({ data: { clientDomain: domain, orgId: org, emailDomain: 'verified.example.com',
      status: 'VERIFIED', verifiedAt: new Date(), challengeHash: 'hashed', challengeExpiresAt: new Date() } });
    const admitted = await db.$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      return admitEnterpriseIdentity({ connection: provider, policy, config, context, identity: { ...identity,
        subject: 'stable-new', email: `new-${suffix}@verified.example.com` } }, tx);
    });
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') throw new Error('Expected scoped JIT');
    expect(admitted.user.passwordHash).toBeNull();
    expect(admitted.evidence.provenance).toBe('sso');
    expect(admitted.evidence.authenticatedAt).toBeNull();
    expect(admitted.evidence.orgId).toBe(org);
    expect(admitted.evidence.connectionId).toBe(connection);
    expect(await db.domainRole.count({ where: { userId: admitted.user.id } })).toBe(0);
    expect((await db.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: org, userId: admitted.user.id } } })).role).toBe('member');
    const sibling = await db.organisation.create({ data: { domain, ownerId: admitted.user.id,
      name: 'Private sibling', slug: `sibling-${suffix}` } });
    await db.orgMember.create({ data: { orgId: sibling.id, userId: admitted.user.id, role: 'owner' } });
    const siblingTeam = await db.team.create({ data: { orgId: sibling.id, name: 'Private', slug: 'private' } });
    await db.teamMember.create({ data: { teamId: siblingTeam.id, userId: admitted.user.id } });
    const choices = await buildSessionChoices({ userId: admitted.user.id, authenticationEvidenceId: admitted.evidence.id,
      config: { ...config, org_features: { enabled: true, allow_user_create_org: true, allow_user_create_team: true } } as ClientConfig },
    { prisma: db, crossProductPrisma: db, policyPrisma: db });
    expect(choices.teams.map((row) => row.orgId)).toEqual([org]);
    expect(choices.manageable_orgs ?? []).toEqual([]);
    expect(choices.creatable_orgs).toEqual([]);
    expect(choices.can_create_org).toBe(false);
    await expect(assertIndependentChooserMutation({ authenticationEvidenceId: admitted.evidence.id,
      userId: admitted.user.id, credentialEpoch: admitted.user.tokenVersion, domain }, db)).rejects.toThrow('SSO_TEAM_REAUTH_REQUIRED');
  });
});
