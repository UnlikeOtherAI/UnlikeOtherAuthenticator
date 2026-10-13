import { type Prisma, type PrismaClient } from '@prisma/client';
import type { CommercialEventsV1, CommercialEventV1, CommercialAcknowledgementV1, ProductCommercialSubject }
  from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { lockCommercialAuthority } from './billing-product-authority.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';

export async function companyBillingRecipients(tx: Prisma.TransactionClient, orgId: string) {
  return tx.orgMember.findMany({ where: { orgId, status: 'ACTIVE', role: { in: ['owner', 'admin'] },
    user: { lifecycleStatus: 'ACTIVE' } }, select: { userId: true }, orderBy: { userId: 'asc' } });
}

export async function listCommercialEvents(input: { request: ProductCommercialSubject;
  credential: VerifiedBillingAppKey }, deps?: { prisma?: PrismaClient; now?: () => Date }): Promise<CommercialEventsV1> {
  return (deps?.prisma ?? getAdminPrisma()).$transaction(async (tx) => {
    await lockCommercialAuthority(tx, { credential: input.credential, product: input.request.product,
      organisationId: input.request.organisation_id, purpose: 'COMMERCIAL_WORKER' });
    const recipients = await companyBillingRecipients(tx, input.request.organisation_id);
    const ids = recipients.map((row) => row.userId);
    const now = deps?.now?.() ?? new Date();
    const work = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT n.id FROM billing_commercial_notifications n
      JOIN billing_commercial_incidents i ON i.id=n.incident_id
      WHERE i.service_id=${input.credential.service.id} AND i.org_id=${input.request.organisation_id}
        AND n.due_at<=${now} AND ((i.resolved_at IS NULL AND n.stage<>'resolved')
          OR (i.resolved_at IS NOT NULL AND n.stage='resolved'))
        AND (i.category<>'phone' OR n.stage='resolved' OR EXISTS(
          SELECT 1 FROM billing_sms_number_resources r WHERE r.id=i.resource_id AND r.state<>'ended'))
        AND (
          EXISTS(SELECT 1 FROM org_members m JOIN users u ON u.id=m.user_id
            WHERE m.org_id=i.org_id AND m.status='ACTIVE' AND m.role IN('owner','admin') AND u.lifecycle_status='ACTIVE'
              AND (NOT EXISTS(SELECT 1 FROM billing_commercial_acknowledgements a
                WHERE a.notification_id=n.id AND a.recipient_user_id=m.user_id AND a.channel='alert')
                OR NOT EXISTS(SELECT 1 FROM billing_commercial_acknowledgements a
                WHERE a.notification_id=n.id AND a.recipient_user_id=m.user_id AND a.channel='personal_assistant')))
          OR (n.stage='release_due' AND i.category='phone' AND i.resolved_at IS NULL
            AND EXISTS(SELECT 1 FROM billing_sms_number_resources r WHERE r.id=i.resource_id AND r.state<>'ended')))
      ORDER BY n.last_polled_at ASC NULLS FIRST,n.due_at,n.id LIMIT 100`;
    const events: CommercialEventV1[] = [];
    for (const item of work) {
      const stage = await tx.billingCommercialNotification.findUniqueOrThrow({ where: { id: item.id } });
      const incident = await tx.billingCommercialIncident.findUniqueOrThrow({ where: { id: stage.incidentId } });
      if (stage.stage === 'release_due' && incident.resourceId) {
        const resource = await tx.billingSmsNumberResource.findUnique({ where: { id: incident.resourceId } });
        if (!resource || resource.state === 'ended') continue;
      }
      const accepted = await tx.billingCommercialAcknowledgement.findMany({ where: {
        serviceId: input.credential.service.id, notificationId: stage.id,
      } });
      const channels = ['alert', 'personal_assistant'] as const;
      const pendingIds = ids.filter((id) => channels.some((channel) =>
        !accepted.some((receipt) => receipt.recipientUserId === id && receipt.channel === channel)));
      events.push({ ...input.request, event_id: stage.id, incident_id: incident.id,
        category: incident.category as CommercialEventV1['category'], stage: stage.stage as CommercialEventV1['stage'],
        failed_at: incident.failedAt.toISOString(), grace_ends_at: incident.graceEndsAt.toISOString(),
        occurred_at: stage.dueAt.toISOString(), recipient_user_ids: pendingIds,
        channels: [...channels], resource_id: incident.resourceId });
      await tx.billingCommercialNotification.update({ where: { id: stage.id }, data: { lastPolledAt: now } });
    }
    return { schema_version: 1, events };
  });
}

export async function acknowledgeCommercialEvent(input: { request: CommercialAcknowledgementV1;
  credential: VerifiedBillingAppKey }, deps?: { prisma?: PrismaClient }) {
  if (!['alert', 'personal_assistant'].includes(input.request.channel)) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_EXTERNAL_EMAIL_ACK_FORBIDDEN');
  }
  return (deps?.prisma ?? getAdminPrisma()).$transaction(async (tx) => {
    await lockCommercialAuthority(tx, { credential: input.credential, product: input.request.product,
      organisationId: input.request.organisation_id, purpose: 'COMMERCIAL_WORKER' });
    const event = await tx.billingCommercialNotification.findUnique({ where: { id: input.request.event_id } });
    const incident = event ? await tx.billingCommercialIncident.findFirst({ where: { id: event.incidentId,
      serviceId: input.credential.service.id, orgId: input.request.organisation_id } }) : null;
    if (!event || !incident || event.dueAt > new Date() ||
      (Boolean(incident.resolvedAt) !== (event.stage === 'resolved'))) throw new AppError('NOT_FOUND', 404);
    await tx.$queryRaw`SELECT id FROM org_members WHERE org_id=${incident.orgId}
      AND user_id=${input.request.recipient_user_id} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM users WHERE id=${input.request.recipient_user_id} FOR SHARE`;
    const recipients = await companyBillingRecipients(tx, incident.orgId);
    if (!recipients.some((row) => row.userId === input.request.recipient_user_id)) {
      throw new AppError('FORBIDDEN', 403, 'BILLING_RECIPIENT_NOT_CURRENT_MANAGER');
    }
    const key = { serviceId: input.credential.service.id, notificationId: event.id,
      channel: input.request.channel, recipientUserId: input.request.recipient_user_id };
    const receipt = await tx.billingCommercialAcknowledgement.upsert({ where: {
      serviceId_notificationId_channel_recipientUserId: key,
    }, create: { ...key, receiptId: input.request.receipt_id }, update: {} });
    if (receipt.receiptId !== input.request.receipt_id) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_NOTIFICATION_RECEIPT_CONFLICT');
    }
    return { accepted: true as const };
  });
}

export async function phoneWarningsAccepted(tx: Prisma.TransactionClient, incidentId: string, orgId: string, now = new Date()) {
  const stages = await tx.billingCommercialNotification.findMany({ where: {
    incidentId, stage: { in: ['initial', 'reminder', 'final_warning'] },
  } });
  const recipients = await companyBillingRecipients(tx, orgId);
  if (stages.length !== 3 || recipients.length === 0) return false;
  const receipts = await tx.billingCommercialAcknowledgement.findMany({ where: {
    notificationId: { in: stages.map((stage) => stage.id) },
  } });
  const accepted = stages.every((stage) => recipients.every((recipient) =>
    ['alert', 'personal_assistant', 'email'].every((channel) => receipts.some((receipt) =>
      receipt.notificationId === stage.id && receipt.recipientUserId === recipient.userId && receipt.channel === channel))));
  if (!accepted) return false;
  const final = stages.find((stage) => stage.stage === 'final_warning');
  if (!final) return false;
  const lastFinalAcceptance = Math.max(...receipts.filter((receipt) => receipt.notificationId === final.id)
    .map((receipt) => receipt.acknowledgedAt.getTime()));
  return lastFinalAcceptance + 86_400_000 <= now.getTime();
}
