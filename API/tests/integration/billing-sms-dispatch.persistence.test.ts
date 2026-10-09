import { vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { smsPaidNumberFixture } from '../helpers/sms-paid-number-fixture.js';
import { smsAccount, smsCredential, smsIds, smsPhone } from '../helpers/sms-financial-fixture.js';
import { reserveSms } from '../../src/services/billing-sms-reservation.service.js';
import { claimSmsDispatch, releaseSmsDispatch } from '../../src/services/billing-sms-dispatch.service.js';
import { settleSmsReceipt } from '../../src/services/billing-sms-receipt.service.js';
import { beginSmsNumber, readSmsNumber } from '../../src/services/billing-sms-number.service.js';
import { attachSmsNumber, endSmsNumber } from '../../src/services/billing-sms-number-lifecycle.service.js';
import { createSmsGrant } from '../../src/services/billing-sms-grant.service.js';

let prisma: PrismaClient;
let cleanup: () => Promise<void>;
let fixture: Awaited<ReturnType<typeof smsPaidNumberFixture>>;
const fingerprint = 'a'.repeat(64);
const subject = { product: 'nessie', organisation_id: smsIds.org, team_id: smsIds.team, user_id: smsIds.user };
function deps() { return { prisma, provider: fixture.provider, stripe: fixture.stripe, stripeLivemode: false }; }
async function reserve(dispatch: string, maxSegments = 1) {
  return reserveSms({ credential: fixture.entitlement,
    actorToken: await fixture.actor('/billing/v1/sms/reservations'), request: { ...subject,
      dispatch_id: dispatch, request_fingerprint: fingerprint, number_id: smsIds.number, allocation_id: 'original-team',
      account_sid: smsAccount, from: smsPhone, to: '+420777000002', quote_id: fixture.outbound.id,
      max_segments: maxSegments, grant_id: null, delegate_id: null } }, deps());
}
function claim(dispatch: string) {
  return claimSmsDispatch({ credential: smsCredential, request: { product: 'nessie',
    dispatch_id: dispatch, request_fingerprint: fingerprint } }, deps());
}
function settle(dispatch: string, digit: string) {
  return settleSmsReceipt({ credential: smsCredential, request: { product: 'nessie', dispatch_id: dispatch,
    request_fingerprint: fingerprint, message_sid: `SM${digit.repeat(32)}` } }, deps());
}

describe.skipIf(!process.env.DATABASE_URL)('SMS paid number and outgoing financial services', () => {
  beforeAll(async () => {
    vi.stubEnv('UOA_SMS_COMMERCIAL_POLICY_VERSION', 'synthetic-policy');
    vi.stubEnv('UOA_SMS_MONTHLY_FEE_EUR', '7.25');
    vi.stubEnv('UOA_SMS_MESSAGE_MARKUP_BPS', '2700');
    const db = await createTestDb();
    if (!db) throw new Error('Financial tests require DATABASE_URL');
    prisma = db.prisma; cleanup = db.cleanup; fixture = await smsPaidNumberFixture(prisma);
  });
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('preserves exact paid monthly terms after display expiry and verifies real cash independently', async () => {
    const paid = await beginSmsNumber({ credential: fixture.lifecycle,
      actorToken: await fixture.actor('/billing/v1/sms/numbers/begin'), request: { ...subject,
        resource_id: smsIds.number, quote_id: fixture.monthly.id, phone_number: smsPhone } }, deps());
    expect(paid).toMatchObject({ state: 'active', acquisition_authorized: true,
      quote: { id: fixture.monthly.id, amount: '9.75' } });
    fixture.cash.available = false;
    await expect(readSmsNumber({ product: 'nessie', resource_id: smsIds.number, credential: smsCredential }, deps()))
      .rejects.toThrow('STRIPE_SUBSCRIPTION_PAYMENT_SET_UNPROVEN');
    fixture.cash.available = true;
    await expect(attachSmsNumber({ credential: smsCredential, request: { product: 'nessie', resource_id: smsIds.number,
      account_sid: smsAccount, phone_number_sid: `PN${'b'.repeat(32)}` } }, deps())).rejects.toThrow();
    expect(await attachSmsNumber({ credential: smsCredential, request: { product: 'nessie', resource_id: smsIds.number,
      account_sid: smsAccount, phone_number_sid: `PN${'a'.repeat(32)}` } }, deps())).toMatchObject({ state: 'active' });
  });

  it('reserves before send, returns exactly one dispatch token, and settles/replays an exact wallet debit', async () => {
    expect(await reserve('outgoing-paid')).toMatchObject({ state: 'reserved', reserved_credits: '16.510000' });
    const claims = await Promise.all([claim('outgoing-paid'), claim('outgoing-paid')]);
    expect(claims.filter((value) => value.dispatch_token !== null)).toHaveLength(1);
    // A later deployment must not re-rate the terms accepted by this reservation.
    vi.stubEnv('UOA_SMS_MESSAGE_MARKUP_BPS', '4100');
    fixture.setReceipt('0.01');
    expect(await settle('outgoing-paid', '1')).toMatchObject({ state: 'settled', consumed_credits: '12.700000' });
    expect(await settle('outgoing-paid', '1')).toMatchObject({ state: 'settled', consumed_credits: '12.700000' });
    expect((await prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: smsIds.credit } })).balanceMicrocredits)
      .toBe(87_300_000n);
    expect(await prisma.billingCreditEntry.count({ where: { smsReservationId: { not: null } } })).toBe(1);
  });

  it('refuses unfunded dispatch without persisting a reservation or a budget hold', async () => {
    await expect(reserve('outgoing-unfunded', 100)).rejects.toMatchObject({
      statusCode: 402, message: 'BILLING_SMS_INSUFFICIENT_CREDITS',
    });
    expect(await prisma.billingSmsReservation.findUnique({ where: { dispatchId: 'outgoing-unfunded' } })).toBeNull();
    expect(await prisma.billingCreditBudgetDispatch.findUnique({ where: { dispatchId: 'outgoing-unfunded' } })).toBeNull();
  });

  it('retains unknown and above-authorized provider outcomes and refuses historical same-route receipts', async () => {
    await reserve('outgoing-unknown'); await claim('outgoing-unknown');
    fixture.setReceipt(null);
    expect(await settle('outgoing-unknown', '2')).toMatchObject({ state: 'uncertain', consumed_credits: null });
    fixture.setReceipt('0.03');
    expect(await settle('outgoing-unknown', '2')).toMatchObject({ state: 'reconciliation', consumed_credits: null });
    await expect(releaseSmsDispatch({ credential: smsCredential, request: { product: 'nessie',
      dispatch_id: 'outgoing-unknown', request_fingerprint: fingerprint, proof: 'no_provider_dispatch', dispatch_token: null } },
    deps())).rejects.toThrow();
    await reserve('outgoing-old'); await claim('outgoing-old');
    fixture.setReceipt('0.01', new Date(Date.now() - 60_000));
    await expect(settle('outgoing-old', '3')).rejects.toThrow('BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
    expect((await prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: smsIds.credit } })).balanceMicrocredits)
      .toBe(87_300_000n);
  });

  it('reconciles a per-segment overcharge even when it fits the reserved message maximum', async () => {
    await reserve('outgoing-segment-bound', 2); await claim('outgoing-segment-bound');
    fixture.setReceipt('0.02');
    expect(await settle('outgoing-segment-bound', '4')).toMatchObject({ state: 'reconciliation', consumed_credits: null });
    expect((await prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: smsIds.credit } })).balanceMicrocredits)
      .toBe(87_300_000n);
  });

  it('refuses ordinary-member grant consent and cannot cancel a still-owned paid provider number', async () => {
    await prisma.orgMember.update({ where: { orgId_userId: { orgId: smsIds.org, userId: smsIds.user } }, data: { role: 'member' } });
    await prisma.teamMember.update({ where: { teamId_userId: { teamId: smsIds.team, userId: smsIds.user } }, data: { teamRole: 'member' } });
    await expect(createSmsGrant({ credential: fixture.lifecycle, actorToken: await fixture.actor('/billing/v1/sms/grants'),
      request: { ...subject, number_id: smsIds.number, allocation_id: 'original-team', delegate_id: 'agent',
        max_segments: 1, idempotency_key: 'member-grant' } }, { prisma })).rejects.toThrow();
    expect(await prisma.billingSmsDispatchGrant.count()).toBe(0);
    await prisma.orgMember.update({ where: { orgId_userId: { orgId: smsIds.org, userId: smsIds.user } }, data: { role: 'owner' } });
    await prisma.teamMember.update({ where: { teamId_userId: { teamId: smsIds.team, userId: smsIds.user } }, data: { teamRole: 'admin' } });
    await expect(endSmsNumber({ credential: smsCredential, request: { product: 'nessie', resource_id: smsIds.number,
      reason: 'released' } }, deps())).rejects.toThrow('BILLING_SMS_PROVIDER_RELEASE_NOT_VERIFIED');
    expect((await prisma.billingSmsNumberResource.findUniqueOrThrow({ where: { id: smsIds.number } })).state).toBe('active');
    fixture.setOwned(false);
    expect(await endSmsNumber({ credential: smsCredential, request: { product: 'nessie', resource_id: smsIds.number,
      reason: 'released' } }, deps())).toMatchObject({ state: 'ended', acquisition_authorized: false });
    expect(fixture.remote.status).toBe('canceled');
  });
});
