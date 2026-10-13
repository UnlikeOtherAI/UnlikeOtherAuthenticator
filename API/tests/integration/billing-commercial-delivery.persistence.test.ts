import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { smsIds, smsCredential, smsPhone } from '../helpers/sms-financial-fixture.js';
import { smsPaidNumberFixture } from '../helpers/sms-paid-number-fixture.js';
import { deliverCommercialEmails } from '../../src/services/billing-commercial-email.service.js';
import { acknowledgeCommercialEvent, listCommercialEvents, phoneWarningsAccepted }
  from '../../src/services/billing-commercial-events.service.js';
import type { EmailMessage } from '../../src/services/email.service.js';
import type { VerifiedBillingAppKey } from '../../src/services/billing-app-key.service.js';

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/config/env.js')>();
  return { ...original, getEnv: () => ({ ...original.getEnv(), EMAIL_FROM: 'billing@example.test' }) };
});

describe.skipIf(!process.env.DATABASE_URL)('commercial delivery recovery in PostgreSQL', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  const now = new Date('2026-10-13T18:00:00Z');
  const worker: VerifiedBillingAppKey = { ...smsCredential, id: 'delivery-worker', purpose: 'COMMERCIAL_WORKER' };
  const request = { product: 'nessie', organisation_id: smsIds.org };
  const sent: EmailMessage[] = [];
  const sendEmail = async (message: EmailMessage) => { sent.push(message); };
  beforeAll(async () => {
    const handle = await createTestDb(); if (!handle) throw new Error('DATABASE_URL_REQUIRED'); db = handle;
    await smsPaidNumberFixture(db.prisma);
    await db.prisma.clientDomain.create({ data: { domain: 'authentication.unlikeotherai.com', label: 'Registered API source' } });
    await db.prisma.billingProductEnrollment.create({ data: { serviceId: smsIds.service, orgId: smsIds.org,
      sourceDomain: 'authentication.unlikeotherai.com' } });
    await db.prisma.billingAppKey.create({ data: { id: worker.id, serviceId: smsIds.service, purpose: worker.purpose,
      name: 'Synthetic delivery worker', keyPrefix: worker.id, secretDigest: worker.id,
      actorIssuer: worker.actorIssuer, actorAudience: worker.actorAudience, actorKeyId: worker.actorKeyId, actorPublicJwk: {} } });
    await db.prisma.user.createMany({ data: [
      { id: 'delivery-admin', email: 'admin@example.test', userKey: 'admin@example.test' },
      { id: 'delivery-member', email: 'member@example.test', userKey: 'member@example.test' },
    ] });
    await db.prisma.orgMember.createMany({ data: [
      { orgId: smsIds.org, userId: 'delivery-admin', role: 'admin' },
      { orgId: smsIds.org, userId: 'delivery-member', role: 'member' },
    ] });
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });

  async function incident(id: string, category = 'phone', resolved = false) {
    await db.prisma.billingStripeWebhookEvent.create({ data: { id: `evt-${id}`, accountId: smsIds.account,
      stripeEventId: `evt-${id}`, type: 'invoice.payment_failed', livemode: false, stripeCreatedAt: now } });
    return db.prisma.billingCommercialIncident.create({ data: { id, serviceId: smsIds.service,
      orgId: smsIds.org, accountId: smsIds.account, invoiceId: `in-${id}`, category,
      addonSubscriptionId: 'sms-subscription', resourceId: category === 'phone' ? smsIds.number : null,
      failedAt: new Date(now.getTime() - 7 * 86_400_000),
      graceEndsAt: now, billingTimezone: 'UTC', failureEventId: `evt-${id}`,
      ...(resolved ? { resolvedAt: now, resolutionEventId: `evt-${id}` } : {}) } });
  }
  async function notification(id: string, stage = 'initial') {
    return db.prisma.billingCommercialNotification.create({ data: { id: `notice-${id}-${stage}`,
      incidentId: id, stage, dueAt: new Date(now.getTime() - 86_400_000) } });
  }
  it.each([undefined, 'disabled'])('cannot turn email provider=%s into an accepted transport receipt', async (provider) => {
    vi.stubEnv('EMAIL_PROVIDER', provider);
    const queue = vi.spyOn(db.prisma, '$executeRaw').mockRejectedValue(new Error('DISABLED_TRANSPORT_MUST_NOT_CREATE_WORK'));
    try {
      await expect(deliverCommercialEmails({ prisma: db.prisma, now: () => now })).resolves.toBeUndefined();
      expect(queue).not.toHaveBeenCalled();
    } finally { queue.mockRestore(); vi.unstubAllEnvs(); }
  });
  it('delivers later real work despite more than100 resolved warnings, only to current company managers', async () => {
    await incident('resolved', 'phone', true); await incident('live');
    const historical = Array.from({ length: 120 }, (_, index) => ({ id: `old-${index}`, serviceId: smsIds.service,
      orgId: smsIds.org, accountId: smsIds.account, invoiceId: `in-old-${index}`, category: 'phone',
      addonSubscriptionId: 'sms-subscription', resourceId: smsIds.number, failedAt: new Date('2026-10-01T00:00:00Z'),
      graceEndsAt: new Date('2026-10-08T00:00:00Z'), billingTimezone: 'UTC', failureEventId: 'evt-resolved',
      resolvedAt: new Date('2026-10-02T00:00:00Z'), resolutionEventId: 'evt-resolved' }));
    await db.prisma.billingCommercialIncident.createMany({ data: historical });
    await db.prisma.billingCommercialNotification.createMany({ data: historical.map((row) => ({ id: `notice-${row.id}`,
      incidentId: row.id, stage: 'initial', dueAt: row.failedAt })) });
    const live = await notification('live');
    await deliverCommercialEmails({ prisma: db.prisma, now: () => now, sendEmail });
    expect(sent.map((message) => message.to).sort()).toEqual(['admin@example.test', 'sms@example.test']);
    for (const message of sent) {
      expect(message.text).toContain(`Phone number ${smsPhone}`);
      expect(message.text).toContain('https://app.example.test/admin/billing');
      expect(message.text).not.toContain('https://authentication.unlikeotherai.com/admin/billing');
      expect(message.messageId).toMatch(/^<uoa-commercial-[a-f0-9]{64}@app\.example\.test>$/);
    }
    expect(await db.prisma.billingCommercialAcknowledgement.count({ where: { notificationId: live.id, channel: 'email' } })).toBe(2);
    await deliverCommercialEmails({ prisma: db.prisma, now: () => now, sendEmail });
    expect(sent).toHaveLength(2);
  });
  it('retries unaccepted SMTP with the same delivery identity and never turns an outage into an accepted receipt', async () => {
    await incident('retry'); const notice = await notification('retry');
    const attempted: EmailMessage[] = [];
    await deliverCommercialEmails({ prisma: db.prisma, now: () => now, sendEmail: async (message) => {
      attempted.push(message); throw new Error('SYNTHETIC_SMTP_OUTAGE');
    } });
    expect(attempted).toHaveLength(2);
    expect(await db.prisma.billingCommercialAcknowledgement.count({ where: { notificationId: notice.id, channel: 'email' } })).toBe(0);
    await deliverCommercialEmails({ prisma: db.prisma, now: () => new Date(now.getTime() + 300_001), sendEmail });
    expect(sent.slice(-2).map((message) => message.messageId).sort()).toEqual(attempted.map((message) => message.messageId).sort());
    expect(await db.prisma.billingCommercialAcknowledgement.count({ where: { notificationId: notice.id, channel: 'email' } })).toBe(2);
  });
  it('rechecks roles for external receipts and cannot fabricate an email acceptance or replay a conflicting receipt', async () => {
    const feed = await listCommercialEvents({ request, credential: worker }, { prisma: db.prisma, now: () => now });
    const event = feed.events.find((row) => row.incident_id === 'live'); if (!event) throw new Error('NOTICE_REQUIRED');
    expect(event.recipient_user_ids.sort()).toEqual(['delivery-admin', smsIds.user].sort());
    const ack = { ...request, event_id: event.event_id, recipient_user_id: 'delivery-admin', channel: 'alert' as const,
      receipt_id: 'accepted-product-alert' };
    await db.prisma.orgMember.updateMany({ where: { orgId: smsIds.org, userId: 'delivery-admin' }, data: { role: 'member' } });
    await expect(acknowledgeCommercialEvent({ request: ack, credential: worker }, { prisma: db.prisma })).rejects.toThrow('BILLING_RECIPIENT_NOT_CURRENT_MANAGER');
    await db.prisma.orgMember.updateMany({ where: { orgId: smsIds.org, userId: 'delivery-admin' }, data: { role: 'admin' } });
    expect(await acknowledgeCommercialEvent({ request: ack, credential: worker }, { prisma: db.prisma })).toEqual({ accepted: true });
    await expect(acknowledgeCommercialEvent({ request: { ...ack, receipt_id: 'other-product-alert' }, credential: worker },
      { prisma: db.prisma })).rejects.toThrow('BILLING_NOTIFICATION_RECEIPT_CONFLICT');
    // Malicious HTTP input must be rejected even if it bypasses protocol validation.
    // @ts-expect-error Email transport receipts belong exclusively to UOA SMTP.
    await expect(acknowledgeCommercialEvent({ request: { ...ack, channel: 'email' }, credential: worker },
      { prisma: db.prisma })).rejects.toThrow('BILLING_EXTERNAL_EMAIL_ACK_FORBIDDEN');
  });
  it('waits24hours after a delayed accepted final warning and stops delivery/release work for an ended number', async () => {
    await incident('late-final');
    for (const stage of ['initial', 'reminder', 'final_warning']) {
      const notice = await notification('late-final', stage);
      await db.prisma.billingCommercialAcknowledgement.createMany({ data: ['delivery-admin', smsIds.user].flatMap((userId) =>
        ['alert', 'personal_assistant', 'email'].map((channel) => ({ serviceId: smsIds.service,
          notificationId: notice.id, recipientUserId: userId, channel, receiptId: `${notice.id}:${userId}:${channel}`,
          acknowledgedAt: stage === 'final_warning' ? now : new Date(now.getTime() - 86_400_000) }))) });
    }
    expect(await db.prisma.$transaction((tx) => phoneWarningsAccepted(tx, 'late-final', smsIds.org, now))).toBe(false);
    expect(await db.prisma.$transaction((tx) => phoneWarningsAccepted(tx, 'late-final', smsIds.org,
      new Date(now.getTime() + 86_400_000)))).toBe(true);
    await notification('late-final', 'release_due');
    await db.prisma.billingSmsNumberResource.update({ where: { id: smsIds.number }, data: { state: 'ended' } });
    const feed = await listCommercialEvents({ request, credential: worker }, { prisma: db.prisma, now: () => now });
    expect(feed.events.some((row) => row.category === 'phone')).toBe(false);
    expect((await db.prisma.billingCommercialIncident.findUniqueOrThrow({ where: { id: 'late-final' } })).resolvedAt).toBeNull();
    await deliverCommercialEmails({ prisma: db.prisma, now: () => new Date(now.getTime() + 86_400_000), sendEmail });
    expect(sent).toHaveLength(4);
  });
});
