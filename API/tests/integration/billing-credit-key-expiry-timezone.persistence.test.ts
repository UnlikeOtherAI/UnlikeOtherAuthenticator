import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { observedBillingTime } from '../../src/services/billing-seat-observed-time.service.js';
import { createBillingTimezoneDb } from '../helpers/billing-timezone-db.js';

const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled).each(['UTC', 'Europe/London', 'America/New_York', 'Asia/Kathmandu'])(
  'billing credit key expiry in %s', (zone) => {
    let db: Awaited<ReturnType<typeof createBillingTimezoneDb>>;
    beforeAll(async () => {
      db = await createBillingTimezoneDb(zone);
      const now = await observedBillingTime(db.prisma);
      await db.prisma.billingService.create({ data: { id: 'service', identifier: 'nessie', name: 'Nessie' } });
      for (const [id, offset, revoked] of [
        ['valid', 600_000, false], ['expired', -600_000, false], ['revoked', 600_000, true],
      ] as const) {
        await db.prisma.billingAppKey.create({ data: {
          id, serviceId: 'service', purpose: 'CUSTOMER_LIFECYCLE', name: id,
          keyPrefix: `uoa_test_${id}`, secretDigest: id.padEnd(64, '0'),
          actorIssuer: 'https://billing-eval.example', actorAudience: 'https://uoa.example/billing/v1/credits',
          actorKeyId: 'test-key', actorPublicJwk: {}, checkoutReturnOrigins: ['https://billing-eval.example'],
          createdAt: new Date(now.getTime() - 3_600_000),
          expiresAt: new Date(now.getTime() + offset), revokedAt: revoked ? now : null,
        } });
      }
    }, 60_000);
    afterAll(async () => { await db?.cleanup(); });
    afterEach(async () => {
      expect(await db.prisma.$queryRaw`SHOW TimeZone`).toEqual([{ TimeZone: zone }]);
    });

    it('accepts a current key at the final credit mutation boundary', async () => {
      await expect(db.prisma.$executeRaw`SELECT billing_assert_credit_app_key('service', 'valid')`)
        .resolves.toBe(1);
      await expect(db.prisma.$executeRaw`SELECT billing_assert_credit_app_key_provenance('valid', true)`)
        .resolves.toBe(1);
    });

    it('rejects an expired key at both credit mutation boundaries', async () => {
      await expect(db.prisma.$executeRaw`SELECT billing_assert_credit_app_key('service', 'expired')`)
        .rejects.toThrow('billing app key is not active');
      await expect(db.prisma.$executeRaw`SELECT billing_assert_credit_app_key_provenance('expired', true)`)
        .rejects.toThrow('billing app key is not valid lifecycle provenance');
    });

    it('keeps revocation and exact service binding enforced', async () => {
      await expect(db.prisma.$executeRaw`SELECT billing_assert_credit_app_key('service', 'revoked')`)
        .rejects.toThrow('billing app key is not active');
      await expect(db.prisma.$executeRaw`SELECT billing_assert_credit_app_key('other', 'valid')`)
        .rejects.toThrow('billing app key is not active');
      await expect(db.prisma.$executeRaw`SELECT billing_assert_credit_app_key_provenance('revoked', true)`)
        .rejects.toThrow('billing app key is not valid lifecycle provenance');
    });

    it('retains expired or revoked historical provenance without granting new authority', async () => {
      for (const id of ['expired', 'revoked']) {
        await expect(db.prisma.$executeRaw`SELECT billing_assert_credit_app_key_provenance(${id}, false)`)
          .resolves.toBe(1);
      }
    });
  },
);
