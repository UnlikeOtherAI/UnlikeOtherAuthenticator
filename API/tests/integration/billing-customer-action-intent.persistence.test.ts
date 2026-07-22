import {
  BillingAppKeyPurpose,
  BillingAssignmentScope,
  MembershipStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';
import { getAdminAuthDomain } from '../../src/config/env.js';
import { lockBillingAdminEffectAuthority } from '../../src/services/billing-admin-effect-authority.service.js';

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
    await handle.prisma.domainRole.create({
      data: { domain: getAdminAuthDomain(), userId: actor.id, role: UserRole.SUPERUSER },
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

  function actionData(
    actorJti: string,
    overrides: Partial<Prisma.BillingCustomerActionIntentUncheckedCreateInput> = {},
  ): Prisma.BillingCustomerActionIntentUncheckedCreateInput {
    return {
      appKeyId: ids.appKey,
      serviceId: ids.service,
      orgId: ids.org,
      teamId: ids.team,
      requestedByUserId: ids.actor,
      authorityScope: BillingAssignmentScope.TEAM,
      operation: 'credit_top_up',
      actorJti,
      actorTokenVersion: 0,
      actorExpiresAt: new Date(Date.now() + 60_000),
      requestDigest: 'b'.repeat(64),
      ...overrides,
    };
  }

  it('accepts exact team authority and keeps its evidence append-only', async () => {
    const intent = await handle!.prisma.billingCustomerActionIntent.create({
      data: actionData('actor-intent-success'),
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
        data: actionData('actor-intent-revoked', {
          operation: 'stripe_portal',
          requestDigest: 'd'.repeat(64),
        }),
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
    await handle!.prisma.teamMember.update({
      where: { teamId_userId: { teamId: ids.team, userId: ids.actor } },
      data: { teamRole: 'admin' },
    });
  }, 20_000);

  it('rechecks actor and app-key expiry against wall clock after waiting on the lock', async () => {
    for (const expiry of ['actor', 'app_key'] as const) {
      let release = () => undefined;
      let signalLocked = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const locked = new Promise<void>((resolve) => (signalLocked = resolve));
      const expiresAt = new Date(Date.now() + 300);
      const blocker = handle!.prisma.$transaction(async (tx) => {
        await tx.billingAppKey.update({
          where: { id: ids.appKey },
          data: expiry === 'app_key' ? { expiresAt } : { name: 'Billing action intent test' },
        });
        signalLocked();
        await gate;
      });
      await locked;
      let settled = false;
      const actorJti = `actor-intent-expired-${expiry}`;
      const action = handle!.prisma.billingCustomerActionIntent
        .create({
          data: actionData(actorJti, {
            actorExpiresAt:
              expiry === 'actor' ? expiresAt : new Date(Date.now() + 60_000),
          }),
        })
        .then(
          () => {
            settled = true;
            return true;
          },
          () => {
            settled = true;
            return false;
          },
        );
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 350));
      release();
      await blocker;
      await expect(action).resolves.toBe(false);
      await expect(
        handle!.prisma.billingCustomerActionIntent.count({ where: { actorJti } }),
      ).resolves.toBe(0);
      await handle!.prisma.billingAppKey.update({
        where: { id: ids.appKey },
        data: { expiresAt: null },
      });
    }
  }, 20_000);

  it('rejects org membership and app-key revocation committed while an action waits', async () => {
    const cases = [
      {
        name: 'org',
        revoke: async (tx: Prisma.TransactionClient) => {
          await tx.orgMember.update({
            where: { orgId_userId: { orgId: ids.org, userId: ids.actor } },
            data: { status: MembershipStatus.DEACTIVATED },
          });
        },
        restore: () =>
          handle!.prisma.orgMember.update({
            where: { orgId_userId: { orgId: ids.org, userId: ids.actor } },
            data: { status: MembershipStatus.ACTIVE },
          }),
      },
      {
        name: 'app-key',
        revoke: async (tx: Prisma.TransactionClient) => {
          await tx.billingAppKey.update({
            where: { id: ids.appKey },
            data: { revokedAt: new Date() },
          });
        },
        restore: () =>
          handle!.prisma.billingAppKey.update({
            where: { id: ids.appKey },
            data: { revokedAt: null },
          }),
      },
    ];
    for (const testCase of cases) {
      let release = () => undefined;
      let signalLocked = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const locked = new Promise<void>((resolve) => (signalLocked = resolve));
      const revocation = handle!.prisma.$transaction(async (tx) => {
        await testCase.revoke(tx);
        signalLocked();
        await gate;
      });
      await locked;
      const actorJti = `actor-intent-revoked-${testCase.name}`;
      let settled = false;
      const action = handle!.prisma.billingCustomerActionIntent
        .create({ data: actionData(actorJti) })
        .then(
          () => {
            settled = true;
            return true;
          },
          () => {
            settled = true;
            return false;
          },
        );
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      release();
      await revocation;
      await expect(action).resolves.toBe(false);
      await expect(
        handle!.prisma.billingCustomerActionIntent.count({ where: { actorJti } }),
      ).resolves.toBe(0);
      await testCase.restore();
    }
  }, 20_000);

  it('rejects stale customer and admin credential epochs after a concurrent revocation', async () => {
    let release = () => undefined;
    let signalLocked = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));
    const revocation = handle!.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: ids.actor }, data: { tokenVersion: 1 } });
      signalLocked();
      await gate;
    });
    await locked;
    let customerSettled = false;
    let adminSettled = false;
    const customerAction = handle!.prisma.billingCustomerActionIntent
      .create({ data: actionData('actor-intent-stale-epoch') })
      .then(
        () => {
          customerSettled = true;
          return true;
        },
        () => {
          customerSettled = true;
          return false;
        },
      );
    const adminAction = handle!.prisma
      .$transaction((tx) =>
        lockBillingAdminEffectAuthority(tx, {
          userId: ids.actor,
          tokenVersion: 0,
          email: 'billing-intent-actor@example.com',
        }),
      )
      .then(
        () => {
          adminSettled = true;
          return true;
        },
        () => {
          adminSettled = true;
          return false;
        },
      );
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(customerSettled).toBe(false);
    expect(adminSettled).toBe(false);
    release();
    await revocation;
    await expect(customerAction).resolves.toBe(false);
    await expect(adminAction).resolves.toBe(false);
    await handle!.prisma.user.update({ where: { id: ids.actor }, data: { tokenVersion: 0 } });
  }, 20_000);

  it('lets an intent linearized first commit before a later revocation', async () => {
    let release = () => undefined;
    let signalInserted = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inserted = new Promise<void>((resolve) => (signalInserted = resolve));
    const actorJti = 'actor-intent-first';
    const action = handle!.prisma.$transaction(async (tx) => {
      await tx.billingCustomerActionIntent.create({ data: actionData(actorJti) });
      signalInserted();
      await gate;
    });
    await inserted;
    let revoked = false;
    const revocation = handle!.prisma.teamMember
      .update({
        where: { teamId_userId: { teamId: ids.team, userId: ids.actor } },
        data: { teamRole: 'member' },
      })
      .then(() => {
        revoked = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(revoked).toBe(false);
    release();
    await action;
    await revocation;
    await expect(
      handle!.prisma.billingCustomerActionIntent.count({ where: { actorJti } }),
    ).resolves.toBe(1);
    await handle!.prisma.teamMember.update({
      where: { teamId_userId: { teamId: ids.team, userId: ids.actor } },
      data: { teamRole: 'admin' },
    });
  }, 20_000);
});
