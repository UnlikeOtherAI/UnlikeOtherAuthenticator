import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VerifiedBillingAppKey } from '../../src/services/billing-app-key.service.js';
import { resolveEffectiveTariffContext } from '../../src/services/billing-entitlement.service.js';
import { resolveBillingFundingViewer } from '../../src/services/billing-funding-viewer.service.js';
import {
  getResolvedAppFeatureFlags,
  resolveAppFeatureFlags,
} from '../../src/services/feature-flag-resolution.service.js';
import { createTestDb } from '../helpers/test-db.js';

describe.skipIf(!process.env.DATABASE_URL)(
  'Lifecycle enforcement in independent product services',
  () => {
    let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
    beforeAll(async () => {
      db = (await createTestDb())!;
    });
    afterAll(async () => {
      await db?.cleanup();
    });

    async function seed() {
      const suffix = randomUUID();
      const user = await db.prisma.user.create({
        data: { email: `${suffix}@example.test`, userKey: suffix },
      });
      const org = await db.prisma.organisation.create({
        data: {
          ownerId: user.id,
          name: 'Lifecycle scope',
          domain: 'product.example.test',
          slug: suffix,
        },
      });
      const team = await db.prisma.team.create({
        data: { orgId: org.id, name: 'Scope', slug: 'scope', isDefault: true },
      });
      await db.prisma.orgMember.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } });
      await db.prisma.teamMember.create({
        data: { teamId: team.id, userId: user.id, teamRole: 'owner' },
      });
      const app = await db.prisma.app.create({
        data: {
          orgId: org.id,
          name: 'Features',
          identifier: suffix,
          platform: 'web',
          domains: ['product.example.test'],
          featureFlagsEnabled: true,
          roleFlagMatrixEnabled: true,
        },
      });
      await db.prisma.featureFlagDefinition.create({
        data: { appId: app.id, key: 'private_content', defaultState: true },
      });
      const service = await db.prisma.billingService.create({
        data: { identifier: `service-${suffix}`, name: 'Product',
          tariffHistoryFromMonth: new Date().toISOString().slice(0, 7) },
      });
      const createdTariff = await db.prisma.billingTariff.create({
        data: {
          serviceId: service.id,
          key: 'default',
          version: 1,
          name: 'Default',
          mode: 'STANDARD',
          collectionMode: 'NONE',
          markupBps: 0,
          currency: 'USD',
          isDefault: true,
        },
      });
      await db.prisma.billingTariffTermEvent.create({
        data: { serviceId: service.id, source: 'SERVICE_DEFAULT', scopeKey: service.id,
          effectiveFromMonth: service.tariffHistoryFromMonth, tariffId: createdTariff.id,
          reason: 'test-fixture' },
      });
      const credential: VerifiedBillingAppKey = {
        id: `key-${suffix}`,
        purpose: 'ENTITLEMENT',
        actorIssuer: 'https://product.example.test',
        actorAudience: 'https://auth.example.test/billing/v1/effective-tariff',
        actorKeyId: 'test-key',
        actorPublicJwk: {},
        checkoutReturnOrigins: [],
        service,
      };
      const request = {
        product: service.identifier,
        organisationId: org.id,
        teamId: team.id,
        userId: user.id,
      };
      const tariff = () =>
        resolveEffectiveTariffContext(
          {
            request,
            credential,
            actorToken: 'synthetic-verified-actor',
            endpoint: '/billing/v1/effective-tariff',
          },
          {
            prisma: db.prisma,
            verifyActor: async () => ({
              sub: user.id,
              tv: user.tokenVersion,
              iss: credential.actorIssuer,
              aud: credential.actorAudience,
              product: service.identifier,
              organisation_id: org.id,
              team_id: team.id,
              jti: suffix,
              iat: Math.floor(Date.now() / 1000),
              exp: Math.floor(Date.now() / 1000) + 60,
            }),
          },
        );
      const flags = () =>
        getResolvedAppFeatureFlags(
          { appId: app.id, domain: 'product.example.test', userId: user.id, teamId: team.id },
          { prisma: db.prisma },
        );
      return { user, org, team, app, request, tariff, flags };
    }

    it.each(['user', 'organisation', 'team'] as const)(
      'denies %s suspension despite active memberships, then restores access on reactivation',
      async (scope) => {
        const data = await seed();
        await expect(data.tariff()).resolves.toHaveProperty('payload');
        await expect(
          resolveBillingFundingViewer(data.request, { prisma: db.prisma }),
        ).resolves.toHaveProperty('userId', data.user.id);
        await expect(data.flags()).resolves.toEqual({ private_content: true });
        for (const status of ['DISABLED', 'ACTIVE'] as const) {
          if (scope === 'user')
            await db.prisma.user.update({
              where: { id: data.user.id },
              data: { lifecycleStatus: status },
            });
          else if (scope === 'organisation')
            await db.prisma.organisation.update({
              where: { id: data.org.id },
              data: { lifecycleStatus: status },
            });
          else
            await db.prisma.team.update({
              where: { id: data.team.id },
              data: { lifecycleStatus: status },
            });
          if (status === 'DISABLED') {
            await expect(data.tariff()).rejects.toMatchObject({ statusCode: 403 });
            await expect(
              resolveBillingFundingViewer(data.request, { prisma: db.prisma }),
            ).rejects.toMatchObject({ statusCode: 403 });
            await expect(data.flags()).resolves.toEqual({});
            if (scope === 'organisation')
              await expect(
                resolveAppFeatureFlags(data.app, {}, { prisma: db.prisma }),
              ).resolves.toEqual({});
            expect(
              await db.prisma.teamMember.count({
                where: { userId: data.user.id, status: 'ACTIVE' },
              }),
            ).toBe(1);
          } else {
            await expect(data.tariff()).resolves.toHaveProperty('payload');
            await expect(data.flags()).resolves.toEqual({ private_content: true });
          }
        }
      },
    );
  },
);
