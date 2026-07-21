import { BillingAppKeyPurpose, MembershipStatus, Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asPrismaClient, runWithTenantContext } from '../../src/db/tenant-context.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { buildWorkspaceChoices } from '../../src/services/first-login.service.js';
import { resolveProductWorkspacePolicy } from '../../src/services/product-workspace-policy.service.js';

const runsAgainstProductionRoles =
  process.env.RUN_PRODUCT_WORKSPACE_RLS_TESTS === 'true' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DATABASE_ADMIN_URL);

type CrossProductFixture = {
  domain: string;
  orgId: string;
  teamId: string;
  userId: string;
};

/**
 * Read-only production-role canary. This is deliberately opt-in because it
 * requires distinct uoa_app/uoa_admin DSNs with the deployed RLS grants:
 *
 * RUN_PRODUCT_WORKSPACE_RLS_TESTS=true pnpm --filter @uoa/api exec vitest run \
 *   tests/integration/product-workspace-policy-rls.test.ts
 */
describe.skipIf(!runsAgainstProductionRoles)(
  'product workspace policy through production uoa_app/uoa_admin roles',
  () => {
    let adminPrisma: PrismaClient;
    let appPrisma: PrismaClient;

    beforeAll(async () => {
      appPrisma = new PrismaClient({
        datasources: { db: { url: process.env.DATABASE_URL! } },
      });
      adminPrisma = new PrismaClient({
        datasources: { db: { url: process.env.DATABASE_ADMIN_URL! } },
      });
      await Promise.all([appPrisma.$connect(), adminPrisma.$connect()]);
    });

    afterAll(async () => {
      await Promise.all([appPrisma.$disconnect(), adminPrisma.$disconnect()]);
    });

    async function findFixture(): Promise<CrossProductFixture> {
      const appKeys = await adminPrisma.billingAppKey.findMany({
        where: {
          purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          service: { active: true },
        },
        select: { actorIssuer: true },
      });

      for (const appKey of appKeys) {
        let domain: string;
        try {
          const issuer = new URL(appKey.actorIssuer);
          if (issuer.protocol !== 'https:' || issuer.pathname !== '/') continue;
          domain = issuer.hostname.toLowerCase();
        } catch {
          continue;
        }
        const client = await adminPrisma.clientDomain.findUnique({
          where: { domain },
          select: { status: true },
        });
        if (client?.status !== 'active') continue;

        const rows = await adminPrisma.$queryRaw<
          Array<{ orgId: string; teamId: string; userId: string }>
        >(Prisma.sql`
          SELECT
            o.id AS "orgId",
            t.id AS "teamId",
            tm.user_id AS "userId"
          FROM team_members tm
          INNER JOIN teams t ON t.id = tm.team_id
          INNER JOIN organisations o ON o.id = t.org_id
          INNER JOIN org_members om
            ON om.org_id = o.id
           AND om.user_id = tm.user_id
          INNER JOIN users u ON u.id = tm.user_id
          WHERE tm.status = ${MembershipStatus.ACTIVE}::"MembershipStatus"
            AND om.status = ${MembershipStatus.ACTIVE}::"MembershipStatus"
            AND u.domain IS NULL
            AND o.domain <> ${domain}
          ORDER BY tm.created_at ASC
          LIMIT 1
        `);
        const row = rows[0];
        if (row) return { domain, ...row };
      }

      throw new Error('NO_ACTIVE_CROSS_PRODUCT_RLS_FIXTURE');
    }

    it('denies product control-plane reads to uoa_app and exposes choices only through uoa_admin', async () => {
      const [appRole, adminRole, fixture] = await Promise.all([
        appPrisma.$queryRaw<Array<{ role: string }>>`SELECT current_user AS role`,
        adminPrisma.$queryRaw<Array<{ role: string }>>`SELECT current_user AS role`,
        findFixture(),
      ]);
      expect(appRole[0]?.role).toBe('uoa_app');
      expect(adminRole[0]?.role).toBe('uoa_admin');

      await expect(
        resolveProductWorkspacePolicy({ domain: fixture.domain }, { prisma: appPrisma }),
      ).rejects.toBeTruthy();

      const config = {
        domain: fixture.domain,
        org_features: {
          enabled: true,
          allow_user_create_org: false,
        },
      } as ClientConfig;
      const choices = await runWithTenantContext(
        {
          prisma: appPrisma,
          context: { domain: fixture.domain, orgId: null, userId: null },
        },
        (tx) =>
          buildWorkspaceChoices(
            { userId: fixture.userId, config },
            {
              crossProductPrisma: adminPrisma,
              policyPrisma: adminPrisma,
              prisma: asPrismaClient(tx),
            },
          ),
      );

      expect(choices.teams).toContainEqual(
        expect.objectContaining({
          orgId: fixture.orgId,
          teamId: fixture.teamId,
        }),
      );
    });
  },
);
