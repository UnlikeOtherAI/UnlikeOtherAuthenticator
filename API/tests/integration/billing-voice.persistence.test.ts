import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createTestDb } from '../helpers/test-db.js';
import { smsPaidNumberFixture } from '../helpers/sms-paid-number-fixture.js';
import { smsAccount, smsCredential, smsIds, smsPhone } from '../helpers/sms-financial-fixture.js';
import { BillingVoiceProvider, type VoiceReceipt, type VoiceRoute } from '../../src/services/billing-voice-provider.service.js';
import { createVoiceGrant, readVoiceGrant, revokeVoiceGrant } from '../../src/services/billing-voice-grant.service.js';
import { issueVoiceQuote } from '../../src/services/billing-voice-quote.service.js';
import { reserveVoice } from '../../src/services/billing-voice-reservation.service.js';
import { claimVoice, releaseVoice } from '../../src/services/billing-voice-dispatch.service.js';
import { settleVoice } from '../../src/services/billing-voice-receipt.service.js';

let prisma: PrismaClient;
let cleanup: () => Promise<void>;
let fixture: Awaited<ReturnType<typeof smsPaidNumberFixture>>;
const credential = { ...smsCredential, id: 'voice-runtime', purpose: 'VOICE_RUNTIME' as const };
const destination = '+420777000002';
const fingerprint = 'a'.repeat(64);
let priceAmount = '0.01';
const receipts = new Map<string, VoiceReceipt>();
class SyntheticVoice extends BillingVoiceProvider {
  override async ownedNumber() { return; }
  override async price(_route: VoiceRoute) { return { amount: priceAmount, currency: 'USD' as const, source: 'https://pricing.twilio.com/v2/Voice/Numbers/synthetic' }; }
  override async receipt(_route: VoiceRoute, sid: string): Promise<VoiceReceipt> {
    return receipts.get(sid) ?? { terminal: false, amount: null, currency: null, seconds: null, parentCallSid: null, startedAt: null };
  }
}
const policy = { version: 'synthetic', accountSid: smsAccount, region: 'us1' as const,
  expiresAt: new Date(Date.now() + 3600000).toISOString(), markupBps: 2700, billingIncrementSeconds: 60,
  minimumBilledSeconds: 60, maxDurationSeconds: 600, pricingEvidenceDigest: 'a'.repeat(64), cutoffEvidenceDigest: 'b'.repeat(64),
  featureProfile: 'connectivity_only' as const, ancillaryCharges: 'none' as const };
function deps() { return { prisma, stripe: fixture.stripe, stripeLivemode: false,
  provider: fixture.provider, voice: new SyntheticVoice(fixture.provider.configuration), policy }; }
async function grant(direction: 'inbound' | 'outbound' = 'outbound', purpose: 'agent_call' | 'human_transfer' = 'agent_call') {
  return createVoiceGrant({ credential: fixture.lifecycle, actorToken: await fixture.actor('/billing/v1/voice/grants'),
    request: { product: 'nessie', organisation_id: smsIds.org, team_id: smsIds.team, user_id: smsIds.user,
      idempotency_key: randomUUID(), number_id: smsIds.number, allocation_id: 'voice-allocation', delegate_id: 'nessie-agent',
      direction, purpose, max_duration_seconds: 120, max_concurrent_calls: 10, destinations: direction === 'inbound' ? [] : [destination] } }, { prisma });
}
async function reservation(direction: 'inbound' | 'outbound' = 'outbound') {
  const consent = await grant(direction);
  const quoteBody = { product: 'nessie', grant_id: consent.id, delegate_id: consent.delegate_id,
    from: direction === 'inbound' ? destination : smsPhone, to: direction === 'inbound' ? smsPhone : destination,
    max_duration_seconds: 120 };
  const quote = await issueVoiceQuote({ credential, request: quoteBody }, deps());
  const body = { ...quoteBody, dispatch_id: randomUUID(), request_fingerprint: fingerprint, quote_id: quote.id,
    conversation_id: randomUUID(), leg_id: randomUUID(), call_sid: direction === 'inbound' ? `CA${randomUUID().replaceAll('-', '')}` : null,
    parent_reservation_id: null };
  const result = await reserveVoice({ credential, request: body }, deps());
  return { consent, body, result };
}
const claimBody = (dispatch: string) => ({ product: 'nessie', dispatch_id: dispatch, request_fingerprint: fingerprint });
const claim = (dispatch: string) => claimVoice({ credential, request: claimBody(dispatch) }, deps());
async function finish(dispatch: string, sid: string, amount: string | null, seconds = 60) {
  receipts.set(sid, { terminal: true, amount, currency: 'USD', seconds, parentCallSid: null, startedAt: new Date() });
  return settleVoice({ credential, request: { ...claimBody(dispatch), call_sid: sid } }, deps());
}

describe.skipIf(!process.env.DATABASE_URL)('prepaid Voice call legs', () => {
  beforeAll(async () => {
    vi.stubEnv('UOA_SMS_COMMERCIAL_POLICY_VERSION', 'synthetic-policy');
    vi.stubEnv('UOA_SMS_MONTHLY_FEE_EUR', '7.25'); vi.stubEnv('UOA_SMS_MESSAGE_MARKUP_BPS', '2700');
    const db = (await createTestDb())!; prisma = db.prisma; cleanup = db.cleanup;
    fixture = await smsPaidNumberFixture(prisma);
    await prisma.$transaction(async tx => {
      // Isolated synthetic opening wallet, before any Voice activity; no real funding mutation.
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`UPDATE billing_credit_accounts SET balance_microcredits=100000000000 WHERE id=${smsIds.credit}`);
    });
    await prisma.billingAppKey.create({ data: { id: credential.id, serviceId: smsIds.service, purpose: 'VOICE_RUNTIME',
      name: 'Synthetic Voice', keyPrefix: credential.id, secretDigest: credential.id, actorIssuer: credential.actorIssuer,
      actorAudience: credential.actorAudience, actorKeyId: 'synthetic', actorPublicJwk: {} } });
  });
  afterAll(async () => { await cleanup?.(); vi.unstubAllEnvs(); });

  it('exposes only a fresh live issuer billing origin and clears it on revoke', async () => {
    const consent = await grant();
    expect(consent.billing_origin).toBeNull();
    const input = { credential, request: { product: 'nessie', grant_id: consent.id } };
    const before = Date.now();
    const read = await readVoiceGrant(input, { prisma });
    expect(read.billing_origin).toMatchObject({ subject: smsIds.user, token_version: 0,
      organisation_id: smsIds.org, team_id: smsIds.team });
    expect(Date.parse(read.billing_origin!.expires_at)).toBeGreaterThan(before);
    expect(Date.parse(read.billing_origin!.expires_at)).toBeLessThanOrEqual(Date.now() + 60_000);
    expect((await revokeVoiceGrant(input, { prisma })).billing_origin).toBeNull();
    expect((await readVoiceGrant(input, { prisma })).billing_origin).toBeNull();
  });
  it('refuses billing origin after issuer epoch, membership or original key revocation', async () => {
    const consent = await grant();
    const input = { credential, request: { product: 'nessie', grant_id: consent.id } };
    const user = await prisma.user.findUniqueOrThrow({ where: { id: smsIds.user } });
    await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: user.tokenVersion + 1 } });
    try { await expect(readVoiceGrant(input, { prisma })).rejects.toMatchObject({ statusCode: 401 }); }
    finally { await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: user.tokenVersion } }); }
    const member = await prisma.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: smsIds.team, userId: smsIds.user } } });
    await prisma.teamMember.delete({ where: { id: member.id } });
    try { await expect(readVoiceGrant(input, { prisma })).rejects.toMatchObject({ statusCode: 403 }); }
    finally { await prisma.teamMember.create({ data: member }); }
    await prisma.billingAppKey.update({ where: { id: fixture.lifecycle.id }, data: { revokedAt: new Date() } });
    try { await expect(readVoiceGrant(input, { prisma })).rejects.toMatchObject({ statusCode: 403 }); }
    finally { await prisma.billingAppKey.update({ where: { id: fixture.lifecycle.id }, data: { revokedAt: null } }); }
    await expect(readVoiceGrant({ ...input, request: { ...input.request, product: 'other' } }, { prisma }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  it('reserves once, claims once, settles one exact debit and preserves source bindings', async () => {
    const value = await reservation();
    expect(value.result.reserved_credits).toBe('25.400000');
    expect(await reserveVoice({ credential, request: value.body }, deps())).toEqual(value.result);
    await expect(reserveVoice({ credential, request: { ...value.body, leg_id: 'changed' } }, deps())).rejects.toMatchObject({ statusCode: 409 });
    const claims = await Promise.all([claim(value.body.dispatch_id), claim(value.body.dispatch_id)]);
    expect(claims.filter(result => result.dispatch_token)).toHaveLength(1);
    const sid = `CA${'1'.repeat(32)}`;
    expect((await finish(value.body.dispatch_id, sid, null)).state).toBe('uncertain');
    const settled = await finish(value.body.dispatch_id, sid, '0.01');
    expect(settled).toMatchObject({ state: 'settled', consumed_credits: '12.700000' });
    expect(await finish(value.body.dispatch_id, sid, '0.01')).toEqual(settled);
    expect(await prisma.billingCreditEntry.count({ where: { voiceReservationId: settled.reservation_id } })).toBe(1);
    await expect(prisma.billingVoiceReservation.update({ where: { id: settled.reservation_id }, data: { allocationId: 'other' } })).rejects.toThrow();
    await expect(finish(value.body.dispatch_id, sid, '0.02')).rejects.toMatchObject({ statusCode: 409 });
  });
  it('keeps over-bound liability for reconciliation and refuses unproven release', async () => {
    const value = await reservation(); const token = (await claim(value.body.dispatch_id)).dispatch_token;
    const result = await finish(value.body.dispatch_id, `CA${'2'.repeat(32)}`, '0.03');
    expect(result.state).toBe('reconciliation');
    await expect(releaseVoice({ credential, request: { ...claimBody(value.body.dispatch_id),
      proof: 'no_provider_dispatch', dispatch_token: token } }, { prisma })).rejects.toMatchObject({ statusCode: 409 });
  });
  it('revocation blocks claim but permits financial recovery', async () => {
    const value = await reservation();
    await revokeVoiceGrant({ credential, request: { product: 'nessie', grant_id: value.consent.id } }, { prisma });
    await expect(claim(value.body.dispatch_id)).rejects.toMatchObject({ statusCode: 403 });
    expect((await releaseVoice({ credential, request: { ...claimBody(value.body.dispatch_id),
      proof: 'no_provider_dispatch', dispatch_token: null } }, { prisma })).state).toBe('released');
  });
  it('binds inbound caller evidence without a caller user principal', async () => {
    const value = await reservation('inbound');
    expect(value.body.call_sid).not.toBeNull(); await claim(value.body.dispatch_id);
    expect((await finish(value.body.dispatch_id, value.body.call_sid!, '0.01')).state).toBe('settled');
    const row = await prisma.billingVoiceReservation.findUniqueOrThrow({ where: { id: value.result.reservation_id } });
    expect(row.userId).toBe(smsIds.user); // Explicit consenting payer, never the external caller.
  });
  it('refuses expired policy, unauthorized destination and foreign team', async () => {
    const value = await reservation();
    await expect(issueVoiceQuote({ credential, request: { ...value.body, to: '+420777000003' } }, deps())).rejects.toMatchObject({ statusCode: 403 });
    await expect(issueVoiceQuote({ credential, request: value.body }, { ...deps(), policy: { ...policy,
      expiresAt: new Date(Date.now() - 1000).toISOString() } })).rejects.toMatchObject({ statusCode: 503 });
    await expect(createVoiceGrant({ credential: fixture.lifecycle, actorToken: await fixture.actor('/billing/v1/voice/grants'),
      request: { product: 'nessie', organisation_id: smsIds.org, team_id: 'other-team', user_id: smsIds.user,
        idempotency_key: randomUUID(), number_id: smsIds.number, allocation_id: 'x', delegate_id: 'x', direction: 'inbound',
        purpose: 'agent_call', max_duration_seconds: 60, max_concurrent_calls: 1, destinations: [] } }, { prisma })).rejects.toThrow();
  });
  it('serializes Voice holds against the canonical wallet SQL guard', async () => {
    const value = await reservation();
    const row = await prisma.billingVoiceReservation.findUniqueOrThrow({ where: { id: value.result.reservation_id } });
    await expect(prisma.billingVoiceReservation.create({ data: { ...row, id: randomUUID(), dispatchId: randomUUID(),
      legId: randomUUID(), reservedMicrocredits: 100_000_000n } })).rejects.toThrow(/insufficient|binding/);
    await expect(prisma.$executeRaw(Prisma.sql`UPDATE billing_credit_accounts SET balance_microcredits=0 WHERE id=${smsIds.credit}`)).rejects.toThrow();
  });
  it('funds a permitted transfer separately and verifies the provider parent leg', async () => {
    const parent = await reservation('inbound'); await claim(parent.body.dispatch_id);
    const consent = await grant('outbound', 'human_transfer');
    const route = { product: 'nessie', grant_id: consent.id, delegate_id: consent.delegate_id,
      from: smsPhone, to: destination, max_duration_seconds: 120 };
    const quote = await issueVoiceQuote({ credential, request: route }, deps());
    const body = { ...route, dispatch_id: randomUUID(), request_fingerprint: fingerprint, quote_id: quote.id,
      conversation_id: parent.body.conversation_id, leg_id: randomUUID(), call_sid: null,
      parent_reservation_id: parent.result.reservation_id };
    await expect(reserveVoice({ credential, request: { ...body, parent_reservation_id: null } }, deps())).rejects.toThrow();
    const child = await reserveVoice({ credential, request: body }, deps()); await claim(body.dispatch_id);
    const sid = `CA${'3'.repeat(32)}`;
    receipts.set(sid, { terminal: true, amount: '0.01', currency: 'USD', seconds: 60,
      parentCallSid: null, startedAt: new Date() });
    await expect(settleVoice({ credential, request: { ...claimBody(body.dispatch_id), call_sid: sid } }, deps())).rejects.toThrow();
    receipts.set(sid, { ...receipts.get(sid)!, parentCallSid: parent.body.call_sid });
    expect((await settleVoice({ credential, request: { ...claimBody(body.dispatch_id), call_sid: sid } }, deps())).state).toBe('settled');
    expect(child.reservation_id).not.toBe(parent.result.reservation_id);
  });
  it('admits only funded concurrent calls against the same canonical wallet', async () => {
    priceAmount = '10';
    try {
      const bodies = [];
      for (let index = 0; index < 4; index += 1) {
        const consent = await grant();
        const route = { product: 'nessie', grant_id: consent.id, delegate_id: consent.delegate_id,
          from: smsPhone, to: destination, max_duration_seconds: 120 };
        const quote = await issueVoiceQuote({ credential, request: route }, deps());
        bodies.push({ ...route, dispatch_id: randomUUID(), request_fingerprint: fingerprint, quote_id: quote.id,
          conversation_id: randomUUID(), leg_id: randomUUID(), call_sid: null, parent_reservation_id: null });
      }
      const results = await Promise.allSettled(bodies.map(request => reserveVoice({ credential, request }, deps())));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3);
      const denied = results.find(result => result.status === 'rejected');
      expect(denied?.status === 'rejected' ? denied.reason : null).toMatchObject({ statusCode: 402 });
    } finally { priceAmount = '0.01'; }
  });

});
