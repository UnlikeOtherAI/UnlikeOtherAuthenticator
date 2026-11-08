import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { smsPaidNumberFixture } from '../helpers/sms-paid-number-fixture.js';
import { smsAccount, smsCredential, smsIds, smsPhone } from '../helpers/sms-financial-fixture.js';
import { readSmsReservation, releaseSmsDispatch } from '../../src/services/billing-sms-dispatch.service.js';
import { settleSmsReceipt } from '../../src/services/billing-sms-receipt.service.js';
import { resolveOrganisationBillingMode } from '../../src/services/billing-organisation-mode.service.js';

describe.skipIf(!process.env.DATABASE_URL)('retained TEAM SMS recovery after organisation cutover', () => {
  let db: PrismaClient;
  let cleanup: () => Promise<void>;
  let fixture: Awaited<ReturnType<typeof smsPaidNumberFixture>>;
  const dispatchId = 'retained-team-sms';
  const walletId = 'retained-team-wallet';
  const messageSid = `SM${'7'.repeat(32)}`;
  const fingerprint = '7'.repeat(64);
  const request = { product: 'nessie', dispatch_id: dispatchId, request_fingerprint: fingerprint };
  beforeAll(async () => {
    const handle = await createTestDb();
    if (!handle) throw new Error('Disposable DATABASE_URL required');
    db = handle.prisma; cleanup = handle.cleanup;
    fixture = await smsPaidNumberFixture(db);
    const [{ activated_at: epoch }] = await db.$queryRaw<Array<{ activated_at: Date }>>`
      SELECT activated_at FROM billing_organisation_scope_cutover WHERE id=1`;
    const capturedAt = new Date(Date.UTC(epoch.getUTCFullYear(), epoch.getUTCMonth() - 1, 15, 12));
    const fx = await db.billingSmsFxSnapshot.findUniqueOrThrow({ where: { id: fixture.outbound.fxSnapshotId } });
    const quoteId = 'retained-team-quote';
    // Seed a synthetic pre-cutover snapshot, never migrate an existing wallet.
    // All recovery operations below run with every production guard enabled.
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role=replica');
      await tx.$executeRaw`UPDATE billing_organisation_modes SET sandbox=false WHERE org_id=${smsIds.org}`;
      await tx.$executeRaw`UPDATE billing_organisation_mode_events SET sandbox=false WHERE org_id=${smsIds.org}`;
      await tx.billingStripeAccount.create({ data: {
        id: 'current-live-account', stripeAccountId: 'acct_SmsFixture', livemode: true,
      } });
      await tx.billingStripeCustomer.createMany({ data: [
        { id: 'retained-team-customer', accountId: smsIds.account, orgId: smsIds.org, teamId: smsIds.team,
          scope: 'TEAM', scopeKey: `${smsIds.org}:${smsIds.team}`, createdAt: capturedAt },
        { id: 'current-live-customer', accountId: 'current-live-account', orgId: smsIds.org,
          scope: 'ORGANISATION', scopeKey: smsIds.org },
      ] });
      await tx.billingCreditAccount.createMany({ data: [
        { id: walletId, accountId: smsIds.account, customerId: 'retained-team-customer',
          orgId: smsIds.org, teamId: smsIds.team, scope: 'TEAM', scopeKey: `${smsIds.org}:${smsIds.team}`,
          balanceMicrocredits: 100_000_000n, createdAt: capturedAt },
        { id: 'current-live-wallet', accountId: 'current-live-account', customerId: 'current-live-customer',
          orgId: smsIds.org, scope: 'ORGANISATION', scopeKey: smsIds.org },
      ] });
      await tx.billingSmsFxSnapshot.create({ data: { ...fx, id: 'retained-team-fx', sourceDigest: fingerprint,
        rateDate: capturedAt, observedAt: capturedAt, acceptedAt: capturedAt,
        expiresAt: new Date(capturedAt.getTime() + 3_600_000) } });
      await tx.billingSmsQuote.create({ data: { ...fixture.outbound, id: quoteId, createdAt: capturedAt,
        providerObservedAt: capturedAt, fxSnapshotId: 'retained-team-fx',
        expiresAt: new Date(capturedAt.getTime() + 3_600_000) } });
      await tx.billingCreditBudgetDispatch.create({ data: {
        dispatchId, contextDigest: fingerprint, serviceId: smsIds.service, providerServiceId: 'twilio-sms',
        orgId: smsIds.org, teamId: smsIds.team, userId: smsIds.user,
        billingMonth: capturedAt.toISOString().slice(0, 7), currency: 'USD', tariffId: `sms-quote:${quoteId}`,
        frozenMarkupBps: 2700, tariffMode: 'STANDARD', paymentMode: 'PREPAID',
        reservedMicrocredits: 16_510_000n, createdAt: capturedAt,
      } });
      await tx.billingSmsReservation.create({ data: {
        dispatchId, requestFingerprint: fingerprint, creditAccountId: walletId,
        serviceId: smsIds.service, appKeyId: fixture.entitlement.id, orgId: smsIds.org,
        teamId: smsIds.team, userId: smsIds.user, actorTokenVersion: 0,
        actorExpiresAt: capturedAt, numberId: smsIds.number, allocationId: 'retained-team', quoteId,
        accountSid: smsAccount, from: smsPhone, to: '+420777000002', maxSegments: 1,
        reservedMicrocredits: 16_510_000n, billingMonth: capturedAt.toISOString().slice(0, 7),
        createdAt: capturedAt, state: 'uncertain', messageSid, dispatchClaimedAt: capturedAt,
      } });
    });
  });
  afterAll(async () => { await cleanup?.(); });

  it('retains the uncertain hold and rejects release without a proven no-dispatch outcome', async () => {
    expect((await resolveOrganisationBillingMode(smsIds.org, db)).mode).toBe('live');
    expect(await readSmsReservation({ credential: smsCredential, request }, { prisma: db }))
      .toMatchObject({ state: 'uncertain', consumed_credits: null, message_sid: messageSid });
    await expect(releaseSmsDispatch({ credential: smsCredential, request: {
      ...request, proof: 'no_provider_dispatch', dispatch_token: null,
    } }, { prisma: db })).rejects.toThrow('BILLING_SMS_RELEASE_OUTCOME_UNPROVEN');
    const blockers = await db.$queryRaw<Array<{ code: string; count: bigint }>>(Prisma.sql`
      SELECT code,count FROM billing_organisation_mode_blockers(${smsIds.org})`);
    expect(blockers).toContainEqual({ code: 'sms_reservation', count: 1n });
  });

  it('settles and replays only the original TEAM Sandbox wallet despite current LIVE selection', async () => {
    const orgWallets = await db.billingCreditAccount.findMany({ where: { scope: 'ORGANISATION' }, orderBy: { id: 'asc' } });
    const retained = await db.billingCreditAccount.findUniqueOrThrow({ where: { id: walletId } });
    const deps = { prisma: db, provider: fixture.provider };
    fixture.setReceipt(null);
    expect(await settleSmsReceipt({ credential: smsCredential, request: { ...request, message_sid: messageSid } }, deps))
      .toMatchObject({ state: 'uncertain', consumed_credits: null });
    fixture.setReceipt('0.01');
    for (let replay = 0; replay < 2; replay++) {
      expect(await settleSmsReceipt({ credential: smsCredential, request: { ...request, message_sid: messageSid } }, deps))
        .toMatchObject({ state: 'settled', consumed_credits: '12.700000' });
    }
    expect(await db.billingCreditAccount.findUnique({ where: { id: walletId } })).toMatchObject({
      ...retained, balanceMicrocredits: 87_300_000n, updatedAt: expect.any(Date),
    });
    expect(await db.billingCreditAccount.findMany({ where: { scope: 'ORGANISATION' }, orderBy: { id: 'asc' } }))
      .toEqual(orgWallets);
    expect(await db.billingCreditEntry.count({ where: { creditAccountId: walletId } })).toBe(1);
    expect(await db.billingPaidUsageLiability.findUnique({ where: { dispatchId } }))
      .toMatchObject({ creditAccountId: walletId, ratedMicrocredits: 12_700_000n });
    const hold = await db.billingCreditBudgetDispatch.findUniqueOrThrow({ where: { dispatchId } });
    expect(hold).toMatchObject({ status: 'SETTLED', isLegacy: false,
      billingAccountId: null, billingScopeEpoch: null, billingModeRevision: null });
  });
});
