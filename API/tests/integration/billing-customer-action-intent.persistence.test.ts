import { BillingAppKeyPurpose, BillingAssignmentScope } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';

const databaseTestsEnabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

describe.skipIf(!databaseTestsEnabled)('customer billing action intent authority races', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  let ids: {
    actor: string;
    appKey: string;
    org: string;
    service: string;
    team: string;
  };

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    const owner = await handle.prisma.user.create({
      data: { email: 'billing-intent-owner@example.com', userKey: 'billing-intent-owner' },
    });
    const actor = await handle.prisma.user.create({
      data: { email: 'billing-intent-actor@example.com', userKey: 'billing-intent-actor' },
    });
    const org = await handle.prisma.organisation.create({
      data: {
        domain: 'billing-intent.example.com',
        name: 'Billing Intent Org',
        slug: 'billing-intent-org',
        ownerId: owner.id,
      },
    });
    await handle.prisma.orgMember.createMany({
      data: [
        { orgId: org.id, userId: owner.id, role: 'owner' },
        { orgId: org.id, userId: actor.id, role: 'member' },
      ],
    });
    const team = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Billing Intent Team', slug: 'billing-intent-team' },
    });
    await handle.prisma.teamMember.createMany({
      data: [
        { teamId: team.id, userId: owner.id, teamRole: 'owner' },
        { teamId: team.id, userId: actor.id, teamRole: 'admin' },
      ],
    });
    const service = await handle.prisma.billingService.create({
      data: { identifier: 'billing-intent-test', name: 'Billing Intent Test' },
    });
    const appKey = await handle.prisma.billingAppKey.create({
      data: {
        serviceId: service.id,
        purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
        name: 'Billing action intent test',
        keyPrefix: 'uoa_intent_test',
        secretDigest: 'a'.repeat(64),
        actorIssuer: 'https://billing-intent.example.com',
        actorAudience: 'https://authentication.example.com/billing',
        actorKeyId: 'billing-intent-key',
        actorPublicJwk: {},
        checkoutReturnOrigins: ['https://billing-intent.example.com'],
      },
    });
    ids = { actor: actor.id, appKey: appKey.id, org: org.id, service: service.id, team: team.id };
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('accepts exact team authority and keeps its evidence append-only', async () => {
    const intent = await handle!.prisma.billingCustomerActionIntent.create({
      data: {
        appKeyId: ids.appKey,
        serviceId: ids.service,
        orgId: ids.org,
        teamId: ids.team,
        requestedByUserId: ids.actor,
        authorityScope: BillingAssignmentScope.TEAM,
        operation: 'credit_top_up',
        actorJti: 'actor-intent-success',
        requestDigest: 'b'.repeat(64),
      },
    });

    await expect(
      handle!.prisma.billingCustomerActionIntent.update({
        where: { id: intent.id },
        data: { requestDigest: 'c'.repeat(64) },
      }),
    ).rejects.toBeDefined();
    await expect(
      handle!.prisma.billingCustomerActionIntent.delete({ where: { id: intent.id } }),
    ).rejects.toBeDefined();
  });

  it('waits for an in-flight role downgrade and then rejects the action', async () => {
    let releaseDowngrade = () => undefined;
    let signalLocked = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseDowngrade = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const downgrade = handle!.prisma.$transaction(async (tx) => {
      await tx.teamMember.update({
        where: { teamId_userId: { teamId: ids.team, userId: ids.actor } },
        data: { teamRole: 'member' },
      });
      signalLocked();
      await gate;
    });
    await locked;

    let settled = false;
    const action = handle!.prisma.billingCustomerActionIntent
      .create({
        data: {
          appKeyId: ids.appKey,
          serviceId: ids.service,
          orgId: ids.org,
          teamId: ids.team,
          requestedByUserId: ids.actor,
          authorityScope: BillingAssignmentScope.TEAM,
          operation: 'stripe_portal',
          actorJti: 'actor-intent-revoked',
          requestDigest: 'd'.repeat(64),
        },
      })
      .then(
        () => {
          settled = true;
          return { ok: true as const };
        },
        (error: unknown) => {
          settled = true;
          return { ok: false as const, error };
        },
      );
    await new Promise((resolve) => setTimeout(resolve, 75));
    const waitedForDowngrade = !settled;
    releaseDowngrade();
    await downgrade;
    const result = await action;

    expect(waitedForDowngrade).toBe(true);
    expect(result.ok).toBe(false);
    await expect(
      handle!.prisma.billingCustomerActionIntent.count({
        where: { actorJti: 'actor-intent-revoked' },
      }),
    ).resolves.toBe(0);
  }, 20_000);
});
