import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { disableBillingCreditAutoTopUp } from '../../src/services/billing-credit-auto-top-up-consent.service.js';
import { observedBillingTime } from '../../src/services/billing-seat-observed-time.service.js';
import { createBillingTimezoneDb } from '../helpers/billing-timezone-db.js';
import {
  credential, databaseTestsEnabled, fundingActionContext, fundingRaceIds as ids,
  fundingRaceRequest as request, seedFundingRace,
} from './billing-credit-funding-actions.persistence.fixture.js';

describe.skipIf(!databaseTestsEnabled).each(['UTC', 'Europe/London', 'America/New_York', 'Asia/Kathmandu'])(
  'automatic top-up disable expiry in %s', (zone) => {
    let db: Awaited<ReturnType<typeof createBillingTimezoneDb>>;
    beforeAll(async () => {
      db = await createBillingTimezoneDb(zone);
      await seedFundingRace(db.prisma);
    }, 60_000);
    afterAll(async () => { await db?.cleanup(); });

    it('rejects expired authority and permits a current manager to stop future reloads', async () => {
      const account = await db.prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: ids.creditAccount } });
      const entryCount = await db.prisma.billingCreditEntry.count({ where: { creditAccountId: account.id } });
      const disable = () => disableBillingCreditAutoTopUp({
        request, actorToken: 'fixture-preauthorized-actor', credential: credential as never,
        endpoint: '/billing/v1/credits/auto-top-up/disable',
      }, { prisma: db.prisma, resolveContext: vi.fn().mockResolvedValue(fundingActionContext(account)) });
      const now = await observedBillingTime(db.prisma);
      await db.prisma.billingAppKey.update({ where: { id: ids.appKey },
        data: { expiresAt: new Date(now.getTime() - 600_000) } });
      await expect(disable()).rejects.toThrow('automatic top-up disable event lacks current exact authority');
      expect(await db.prisma.billingCreditAutoTopUpDisableEvent.count()).toBe(0);
      expect(await db.prisma.billingCreditAccount.findUnique({ where: { id: account.id } }))
        .toMatchObject({ autoTopUpState: 'ACTIVE', autoTopUpGeneration: account.autoTopUpGeneration });

      await db.prisma.billingAppKey.update({ where: { id: ids.appKey },
        data: { expiresAt: new Date(now.getTime() + 600_000) } });
      await disable();
      expect(await db.prisma.billingCreditAccount.findUnique({ where: { id: account.id } })).toMatchObject({
        autoTopUpState: 'DISABLED', autoTopUpGeneration: account.autoTopUpGeneration + 1,
        autoTopUpConsentRevisionId: null, stripePaymentMethodId: null,
      });
      expect(await db.prisma.billingCreditAutoTopUpDisableEvent.count()).toBe(1);
      expect(await db.prisma.billingCreditEntry.count({ where: { creditAccountId: account.id } })).toBe(entryCount);
      expect(await db.prisma.$queryRaw`SHOW TimeZone`).toEqual([{ TimeZone: zone }]);
    });
  },
);
