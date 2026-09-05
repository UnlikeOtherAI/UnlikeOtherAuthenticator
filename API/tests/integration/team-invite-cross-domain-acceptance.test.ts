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
 * Every client domain is equal. An organisation belongs to whoever founded it
 * and is usable from every UOA-integrated product, so the organisation's origin
 * domain says nothing about whether an invitation into it may be accepted —
 * which is exactly what `acceptTeamInviteWithinTransaction` has always claimed
 * in its own comments.
 *
 * It nevertheless ended by filtering the invitee's memberships by the inviting
 * product's domain. A cross-product invitee can never satisfy that: they hold
 * no membership row anywhere until this call creates one, and the rows it
 * creates belong to the founding product's organisation. Every such acceptance
 * was refused with a bare 401, surfacing as "Invitation unavailable" on the
 * mail-bound flow.
 */
describe.skipIf(!hasDatabase)('accepting an invitation into a cross-product organisation', () => {
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
  });

  const config = validateConfigFields(
    baseClientConfigPayload({
      domain: invitingDomain,
      org_features: { enabled: true },
    }),
  );

  async function seedInvite(options?: { tombstonedMembership?: boolean }) {
    const owner = await handle.prisma.user.create({
      data: { email: 'owner@example.com', userKey: 'owner@example.com' },
      select: { id: true },
    });
    const invitee = await handle.prisma.user.create({
      data: { email: 'invitee@example.com', userKey: 'invitee@example.com' },
      select: { id: true },
    });
    const org = await handle.prisma.organisation.create({
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

    if (options?.tombstonedMembership) {
      await handle.prisma.orgMember.create({
        data: { orgId: org.id, userId: invitee.id, role: 'member', status: 'REMOVED' },
      });
      await handle.prisma.teamMember.create({
        data: { teamId: team.id, userId: invitee.id, teamRole: 'member', status: 'REMOVED' },
      });
    }

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
    return { inviteId: invite.id, userId: invitee.id, teamId: team.id, orgId: org.id };
  }

  const accept = (inviteId: string, userId: string) =>
    runInTransaction(handle!.prisma, (tx) =>
      acceptTeamInviteWithinTransaction({
        prisma: tx,
        teamInviteId: inviteId,
        userId,
        config,
        now: new Date(),
      }),
    );

  it('joins the invitee, whichever product founded the organisation', async () => {
    const { inviteId, userId, teamId, orgId } = await seedInvite();

    await expect(accept(inviteId, userId)).resolves.toMatchObject({ orgId, teamId });

    const [teamMembership, orgMembership] = await Promise.all([
      handle.prisma.teamMember.findFirst({
        where: { teamId, userId },
        select: { status: true },
      }),
      handle.prisma.orgMember.findFirst({
        where: { orgId, userId },
        select: { status: true },
      }),
    ]);
    expect(teamMembership?.status).toBe('ACTIVE');
    expect(orgMembership?.status).toBe('ACTIVE');
  });

  it('still refuses a membership that was removed, rather than reactivating it', async () => {
    const { inviteId, userId } = await seedInvite({ tombstonedMembership: true });

    // Dropping the domain comparison must not weaken the tombstone rule.
    await expect(accept(inviteId, userId)).rejects.toMatchObject({ statusCode: 401 });
  });
});
