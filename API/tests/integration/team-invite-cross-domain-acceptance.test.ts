import { BillingAppKeyPurpose } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runInTransaction } from '../../src/db/tenant-context.js';
import { acceptTeamInviteWithinTransaction } from '../../src/services/team-invite.service.acceptance.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

/** The product issuing the invitation. */
const invitingDomain = 'client.example.com';
/** The organisation was founded through a different product on the same UOA. */
const foundingDomain = 'other-product.example.com';

/**
 * One organisation is usable from every UOA-integrated product, so the org's
 * origin domain is not an acceptance predicate — `acceptTeamInviteWithinTransaction`
 * says exactly that in its own comments. The scope gate at the end of that
 * function nevertheless filtered memberships by the inviting product's domain,
 * which no cross-domain invitee can satisfy: they have no membership row at all
 * until this very call creates one. Every such acceptance was refused with a
 * bare 401, which the mail-bound flow renders as "Invitation unavailable".
 */
describe.skipIf(!hasDatabase)('accepting an invitation into a cross-domain organisation', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    await handle.prisma.teamInvite.deleteMany();
    await handle.prisma.teamMember.deleteMany();
    await handle.prisma.orgMember.deleteMany();
    await handle.prisma.team.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.user.deleteMany();
    await handle.prisma.billingAppKey.deleteMany();
    await handle.prisma.billingService.deleteMany();
    await handle.prisma.clientDomain.deleteMany();
  });

  const config = validateConfigFields(
    baseClientConfigPayload({
      domain: invitingDomain,
      org_features: { enabled: true },
    }),
  );

  /** Make `invitingDomain` an active product with exactly one lifecycle key. */
  async function grantSingleProductPolicy(): Promise<void> {
    await handle.prisma.clientDomain.create({
      data: { domain: invitingDomain, label: 'Cross domain product', status: 'active' },
    });
    const service = await handle.prisma.billingService.create({
      data: { identifier: 'cross-domain-product', name: 'Cross domain product' },
    });
    await handle.prisma.billingAppKey.create({
      data: {
        serviceId: service.id,
        purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
        name: 'Cross domain acceptance test',
        keyPrefix: 'uoa_xdomain_test',
        secretDigest: 'b'.repeat(64),
        actorIssuer: `https://${invitingDomain}`,
        actorAudience: 'https://authentication.example.com/billing',
        actorKeyId: 'cross-domain-key',
        actorPublicJwk: {},
        // A CUSTOMER_LIFECYCLE key must carry at least one return origin.
        checkoutReturnOrigins: [`https://${invitingDomain}`],
      },
    });
  }

  async function seedInvite(): Promise<{ inviteId: string; userId: string; teamId: string }> {
    const owner = await handle.prisma.user.create({
      data: { email: 'owner@example.com', userKey: 'owner@example.com' },
      select: { id: true },
    });
    const invitee = await handle.prisma.user.create({
      data: { email: 'invitee@example.com', userKey: 'invitee@example.com' },
      select: { id: true },
    });
    const org = await handle.prisma.organisation.create({
      // Founded through the other product, exactly like an org created in one
      // product and then used from another.
      data: { domain: foundingDomain, name: 'Shared Org', slug: 'shared-org', ownerId: owner.id },
      select: { id: true },
    });
    await handle.prisma.orgMember.create({
      data: { orgId: org.id, userId: owner.id, role: 'owner' },
    });
    const team = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Shared Team', slug: 'shared-team' },
      select: { id: true },
    });
    await handle.prisma.teamMember.create({
      data: { teamId: team.id, userId: owner.id, teamRole: 'owner' },
    });
    const invite = await handle.prisma.teamInvite.create({
      data: {
        orgId: org.id,
        teamId: team.id,
        email: 'invitee@example.com',
        invitedByUserId: owner.id,
        invitedByEmail: 'owner@example.com',
        lastSentAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      },
      select: { id: true },
    });
    return { inviteId: invite.id, userId: invitee.id, teamId: team.id };
  }

  const accept = (inviteId: string, userId: string) =>
    runInTransaction(handle!.prisma, (tx) =>
      acceptTeamInviteWithinTransaction({
        prisma: tx,
        teamInviteId: inviteId,
        userId,
        config,
        now: new Date(),
        // The default admin client resolves from the ambient DATABASE_URL, which
        // is not this test's isolated schema.
        scopeDeps: { crossProductPrisma: tx, policyPrisma: tx },
      }),
    );

  it('joins the invitee when the inviting product maps to one active service', async () => {
    await grantSingleProductPolicy();
    const { inviteId, userId, teamId } = await seedInvite();

    await expect(accept(inviteId, userId)).resolves.toMatchObject({ teamId });

    const membership = await handle.prisma.teamMember.findFirst({
      where: { teamId, userId },
      select: { status: true },
    });
    expect(membership?.status).toBe('ACTIVE');
  });

  it('still refuses when the inviting domain has no single-product mapping', async () => {
    const { inviteId, userId } = await seedInvite();

    // No client domain, no lifecycle key: the relaxation is policy-gated, not free.
    await expect(accept(inviteId, userId)).rejects.toMatchObject({ statusCode: 401 });
  });
});
