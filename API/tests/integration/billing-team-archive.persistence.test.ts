import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { ids, concurrency, aboveThreshold, seed } from '../helpers/credit-auto-top-up-runtime-fixture.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { digestDomainClientHash } from '../../src/utils/client-hash.js';
import { beginTeamArchive } from '../../src/services/team-archive.service.js';
import { claimCreditAutoTopUpAttempt } from '../../src/services/billing-credit-auto-top-up-attempt.service.js';
import { observedBillingTime } from '../../src/services/billing-seat-observed-time.service.js';

describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS !== 'true' || !process.env.DATABASE_URL)(
  'team archive automatic reload evidence', () => {
    let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
    beforeAll(async () => { db = (await createTestDb())!; await seed(db.prisma); });
    afterAll(async () => { await db?.cleanup(); });
    it('disables future reload with archive evidence and retains consent, money and sibling configuration', async () => {
      const domain = 'auto-top-up.example.com', token = 'b'.repeat(64);
      const client = await db.prisma.clientDomain.create({ data: { domain, label: 'Archive funding test' } });
      await db.prisma.clientDomainSecret.create({ data: { domainId: client.id,
        secretDigest: digestDomainClientHash(token), hashPrefix: token.slice(0, 16) } });
      const before = await db.prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: concurrency.creditAccount } });
      const sibling = await db.prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: aboveThreshold.creditAccount } });
      const user = await db.prisma.user.findUniqueOrThrow({ where: { id: ids.user } });
      const service = await db.prisma.billingService.create({ data: { identifier: 'archive-seat-test', name: 'Seats' } });
      const tariff = await db.prisma.billingTariff.create({ data: {
        serviceId: service.id, key: 'seats', version: 1, name: 'Seats', mode: 'CUSTOM', collectionMode: 'MANUAL',
        markupBps: 0, currency: 'USD', monthlyChargeBasis: 'PER_SEAT', seatPolicy: 'AUTOMATIC',
        seatChargeTiming: 'PRORATED', monthlyAmountMinor: 1000n,
      } });
      const contract = await db.prisma.billingOrganisationContract.create({ data: {
        orgId: ids.org, reference: 'archive-seats', name: 'Archive seats',
      } });
      const future = new Date(Date.now() + 86400_000);
      const seats = [];
      for (const versionNumber of [1, 2]) {
        const version = await db.prisma.billingOrganisationContractVersion.create({ data: {
          contractId: contract.id, version: versionNumber, usageMarkupBps: 0, currency: 'USD',
          paymentTermsDays: 30, effectiveFromMonth: versionNumber === 1 ? '2026-11' : '2026-12',
        } });
        const term = await db.prisma.billingContractServiceTerm.create({ data: {
          contractVersionId: version.id, serviceId: service.id, tariffId: tariff.id, monthlyAmountMinor: 1000n,
        } });
        seats.push(await db.prisma.$transaction(async tx => {
          const now = await observedBillingTime(tx);
          return tx.billingSeatSubscription.create({ data: {
            contractServiceTermId: term.id, serviceId: service.id, tariffId: tariff.id, orgId: ids.org,
            teamId: concurrency.team, scope: 'TEAM', seatPolicy: 'AUTOMATIC', seatChargeTiming: 'PRORATED',
            unitAmountMinor: 1000n, currency: 'USD', activatedAt: now, baselineCapturedAt: now,
            commercialEffectiveAt: versionNumber === 1 ? now : future,
            commercialEndsAt: versionNumber === 1 ? future : null,
          } });
        }));
      }
      await beginTeamArchive({ id: randomUUID(), orgId: ids.org, teamId: concurrency.team, domain, domainToken: token,
        config: validateConfigFields(baseClientConfigPayload({ domain })), claims: {
          userId: ids.user, tokenVersion: user.tokenVersion, email: user.email!, domain, clientId: token, role: 'user',
          org: { org_id: ids.org, org_role: 'owner', teams: [concurrency.team], team_roles: {} },
          active: { orgId: ids.org, teamId: concurrency.team },
        },
      }, { prisma: db.prisma });
      const after = await db.prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: concurrency.creditAccount } });
      expect(after).toMatchObject({ autoTopUpState: 'DISABLED', autoTopUpGeneration: before.autoTopUpGeneration + 1,
        balanceMicrocredits: before.balanceMicrocredits, autoTopUpConsentRevisionId: null, stripePaymentMethodId: null });
      expect(await db.prisma.billingCreditAutoTopUpDisableEvent.count({ where: { creditAccountId: after.id } })).toBe(0);
      expect(await db.prisma.billingCreditAutoTopUpConsentRevision.findUnique({ where: { id: before.autoTopUpConsentRevisionId! } })).not.toBeNull();
      expect(await db.prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: sibling.id } })).toEqual(sibling);
      await expect(db.prisma.billingCreditAccount.update({ where: { id: after.id }, data: { autoTopUpState: 'ACTIVE' } }))
        .rejects.toThrow('archived team cannot enable reload');
      expect(await claimCreditAutoTopUpAttempt({ accountId: ids.account, creditAccountId: after.id }, { prisma: db.prisma }))
        .toMatchObject({ kind: 'skipped', reason: 'configuration_inactive' });
      for (const seat of seats) {
        const ended = await db.prisma.billingSeatSubscription.findUniqueOrThrow({ where: { id: seat.id } });
        expect(ended.endedAt).toBeInstanceOf(Date);
        expect(ended.commercialEndsAt).toEqual(seat.commercialEndsAt);
        expect(await db.prisma.billingSeatMembershipInterval.count({ where: { seatSubscriptionId: seat.id, endsAt: null } })).toBe(0);
      }
    });
  },
);
