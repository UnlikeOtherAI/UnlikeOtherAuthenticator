import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { smsPaidNumberFixture } from '../helpers/sms-paid-number-fixture.js';
import { smsAccount, smsCredential, smsIds, smsPhone, smsStanding } from '../helpers/sms-financial-fixture.js';
import { reserveTelephoneSms } from '../../src/services/telephone-sms-reservation.service.js';
import { CALL_PROOF_PATH } from '../../src/services/telephone-call-proof.service.js';
import { claimSmsDispatch, releaseSmsDispatch } from '../../src/services/billing-sms-dispatch.service.js';
import { settleSmsReceipt } from '../../src/services/billing-sms-receipt.service.js';

let prisma: PrismaClient;
let cleanup: () => Promise<void>;
let fixture: Awaited<ReturnType<typeof smsPaidNumberFixture>>;
let holdId: string;
let allocationId = 'telephone-team';
const number = '+420777000002';
const fingerprint = 'a'.repeat(64);
const verifiedAt = new Date();
const deps = () => ({ prisma, provider: fixture.provider, stripe: fixture.stripe, stripeLivemode: false });

async function delivery() {
  const challenge = await prisma.telephoneCallChallenge.create({ data: { id: randomUUID(),
    userId: smsIds.user, appKeyId: smsIds.lifecycle, assertionJti: randomUUID(), callId: randomUUID(),
    organisationId: smsIds.org, teamId: smsIds.team, tokenVersion: 0, number, numberVerifiedAt: verifiedAt,
    codeHash: 'fixture-digest-never-delivered', expiresAt: new Date(Date.now() + 300_000) } });
  return { challenge, body: { number, challengeId: challenge.id, dispatch_id: randomUUID(), request_fingerprint: fingerprint,
    number_id: smsIds.number, allocation_id: allocationId, account_sid: smsAccount, from: smsPhone, max_segments: 1 } };
}
async function reserve(value: Awaited<ReturnType<typeof delivery>>, patch = {}) {
  return reserveTelephoneSms({ credential: fixture.lifecycle, request: { ...value.body, ...patch },
    serviceToken: await fixture.serviceAssertion(`${CALL_PROOF_PATH}/reserve`, { call_id: value.challenge.callId,
      number_digest: createHash('sha256').update(number).digest('hex') }) }, deps());
}
const claim = (dispatch: string) => claimSmsDispatch({ credential: smsCredential,
  request: { product: 'nessie', dispatch_id: dispatch, request_fingerprint: fingerprint } }, deps());

describe.skipIf(!process.env.DATABASE_URL)('telephone proof prepaid SMS admission', () => {
  beforeAll(async () => {
    vi.stubEnv('UOA_SMS_COMMERCIAL_POLICY_VERSION', 'synthetic-policy');
    vi.stubEnv('UOA_SMS_MONTHLY_FEE_EUR', '7.25');
    vi.stubEnv('UOA_SMS_MESSAGE_MARKUP_BPS', '2700');
    const db = (await createTestDb())!;
    prisma = db.prisma; cleanup = db.cleanup;
    fixture = await smsPaidNumberFixture(prisma);
    await prisma.userTelephone.create({ data: { userId: smsIds.user, number, verifiedAt } });
    holdId = (await smsStanding(prisma, allocationId, 1_000_000n)).id;
  });
  afterAll(async () => { await cleanup?.(); vi.unstubAllEnvs(); });

  it('binds the challenge to one prepaid dispatch and uses ordinary claim/receipt settlement', async () => {
    const value = await delivery();
    const first = await reserve(value);
    expect(first).toMatchObject({ dispatch_id: value.body.dispatch_id, state: 'reserved', dispatch_token: null });
    expect(await reserve(value)).toEqual(first);
    await expect(reserve(value, { dispatch_id: randomUUID() })).rejects.toMatchObject({ statusCode: 409 });
    await expect(reserve(value, { max_segments: 2 })).rejects.toMatchObject({ statusCode: 409 });
    const claims = await Promise.all([claim(value.body.dispatch_id), claim(value.body.dispatch_id)]);
    expect(claims.filter(result => result.dispatch_token !== null)).toHaveLength(1);
    fixture.setReceipt('0.01');
    const settled = await settleSmsReceipt({ credential: smsCredential, request: { product: 'nessie',
      dispatch_id: value.body.dispatch_id, request_fingerprint: fingerprint, message_sid: `SM${'7'.repeat(32)}` } }, deps());
    expect(settled).toMatchObject({ state: 'settled', consumed_credits: '12.700000' });
    expect(await prisma.billingCreditEntry.count({ where: { smsReservationId: first.reservation_id } })).toBe(1);
  });

  it('refuses caller-chosen destination, unrelated allocation, sender and excess segments', async () => {
    const value = await delivery();
    for (const patch of [{ number: smsPhone }, { allocation_id: 'another-team' }, { from: '+420777000003' }, { max_segments: 4 }]) {
      await expect(reserve(value, patch)).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(await prisma.billingSmsReservation.findUnique({ where: { dispatchId: value.body.dispatch_id } })).toBeNull();
    await prisma.billingSmsStandingHold.update({ where: { id: holdId }, data: { state: 'retired', retiredAt: new Date() } });
    await expect(reserve(value)).rejects.toMatchObject({ statusCode: 403 });
    allocationId = 'telephone-team-replacement';
    holdId = (await smsStanding(prisma, allocationId, 1_000_000n)).id;
  });

  it('rolls back unfunded admission without a reservation or budget hold', async () => {
    const value = await delivery();
    await prisma.billingSmsStandingHold.update({ where: { id: holdId }, data: { reservedMicrocredits: 85_000_000n } });
    await expect(reserve(value)).rejects.toMatchObject({ statusCode: 402, message: 'BILLING_SMS_INSUFFICIENT_CREDITS' });
    expect(await prisma.billingSmsReservation.findUnique({ where: { dispatchId: value.body.dispatch_id } })).toBeNull();
    expect(await prisma.billingCreditBudgetDispatch.findUnique({ where: { dispatchId: value.body.dispatch_id } })).toBeNull();
    await prisma.billingSmsStandingHold.update({ where: { id: holdId }, data: { reservedMicrocredits: 1_000_000n } });
  });

  it('rechecks expired challenge and original lifecycle key before physical claim, retaining safe release', async () => {
    const value = await delivery();
    await reserve(value);
    await prisma.telephoneCallChallenge.update({ where: { id: value.challenge.id }, data: { expiresAt: new Date(0) } });
    await expect(claim(value.body.dispatch_id)).rejects.toMatchObject({ statusCode: 403 });
    await prisma.telephoneCallChallenge.update({ where: { id: value.challenge.id }, data: { expiresAt: new Date(Date.now() + 300_000) } });
    await prisma.billingAppKey.update({ where: { id: smsIds.lifecycle }, data: { revokedAt: new Date() } });
    await expect(claim(value.body.dispatch_id)).rejects.toMatchObject({ statusCode: 403 });
    expect(await releaseSmsDispatch({ credential: smsCredential, request: { product: 'nessie',
      dispatch_id: value.body.dispatch_id, request_fingerprint: fingerprint, proof: 'no_provider_dispatch', dispatch_token: null } }, { prisma }))
      .toMatchObject({ state: 'released' });
  });
});
