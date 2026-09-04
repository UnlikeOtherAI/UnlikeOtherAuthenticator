import { describe, expect, it } from 'vitest';

import { attestAutomaticMembershipDomain, grantAutomaticMembership, isAutomaticMembershipAdministrator } from '../../src/services/automatic-membership.service.js';

const credential = {
  id: 'key', purpose: 'AUTOMATIC_MEMBERSHIP', actorIssuer: 'https://nessie.works', actorAudience: 'https://authentication.unlikeotherai.com/org', actorKeyId: 'key', actorPublicJwk: {}, checkoutReturnOrigins: [], service: { id: 'nessie', identifier: 'nessie', name: 'Nessie' },
} as never;

describe('automatic membership verified-domain attestation', () => {
  it('accepts only a UOA identity currently verified for the exact domain', async () => {
    const prisma = { billingServiceAccess: { findFirst: async () => ({ id: 'access' }) }, authIdentity: { findMany: async () => [{ email: 'person@engineering.example.com' }, { email: 'person@other.example' }] } } as never;
    const proof = await attestAutomaticMembershipDomain(prisma, credential, { orgId: 'org-1', subject: 'uoa-subject', domain: 'engineering.example.com' });
    expect(proof?.subject).toBe('uoa-subject');
    expect(proof?.domain).toBe('engineering.example.com');
    await expect(attestAutomaticMembershipDomain(prisma, credential, { orgId: 'org-1', subject: 'uoa-subject', domain: 'example.com' })).resolves.toBeNull();
  });

  it('does not expose an identity assertion outside the relying service organisation scope', async () => {
    const prisma = { billingServiceAccess: { findFirst: async () => null }, authIdentity: { findMany: async () => [{ email: 'person@engineering.example.com' }] } } as never;
    await expect(attestAutomaticMembershipDomain(prisma, credential, { orgId: 'org-foreign', subject: 'uoa-subject', domain: 'engineering.example.com' })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('requires an exact active team owner or admin for a team-scoped rule', async () => {
    const prisma = {
      billingServiceAccess: { findFirst: async () => ({ id: 'access' }) },
      team: { findFirst: async ({ where }: { where: { id: string; orgId: string } }) => where.id === 'team-1' && where.orgId === 'org-1' ? { id: 'team-1' } : null },
    } as never;
    await expect(isAutomaticMembershipAdministrator(prisma, credential, { orgId: 'org-1', subject: 'actor', scope: 'team', teamId: 'team-1' })).resolves.toBe(true);
    await expect(isAutomaticMembershipAdministrator(prisma, credential, { orgId: 'org-1', subject: 'actor', scope: 'team', teamId: 'other-team' })).resolves.toBe(false);
  });

  it('skips inactive memberships without reactivating or changing their role', async () => {
    const tx = {
      $queryRaw: async () => [],
      automaticMembershipProvisionFence: { findUnique: async () => ({ active: true, orgId: 'org-1', generation: 2, lifecycleRevision: 3, fenceToken: 'long-fence-token' }) },
      automaticMembershipOperation: { findUnique: async () => null, create: async ({ data }: { data: { status: string } }) => data },
      team: { findFirst: async () => ({ id: 'team-1' }) }, user: { findUnique: async () => ({ id: 'subject-1' }) },
      authIdentity: { findMany: async () => [{ email: 'person@acme.example' }] },
      orgMember: { findUnique: async () => ({ status: 'DEACTIVATED' }), createMany: async () => { throw new Error('must not create'); } },
      teamMember: { findUnique: async () => null, createMany: async () => { throw new Error('must not create'); } },
    } as never;
    const prisma = { billingServiceAccess: { findFirst: async () => ({ id: 'access' }) }, $transaction: async (callback: (value: typeof tx) => unknown) => callback(tx) } as never;
    await expect(grantAutomaticMembership(prisma, credential, { orgId: 'org-1', teamId: 'team-1', subject: 'subject-1', domain: 'acme.example', idempotencyKey: 'idempotency-key-long-enough', ruleId: 'rule-1', generation: 2, lifecycleRevision: 3, fenceToken: 'long-fence-token' })).resolves.toMatchObject({ status: 'skipped_inactive' });
  });
});
