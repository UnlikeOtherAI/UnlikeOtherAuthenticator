import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { sendRawEmail } from './email.service.js';

/** Durable recipient work; at-least-once transport after an acceptance/commit crash. */
export async function deliverCommercialEmails(deps?: { prisma?: PrismaClient;
  sendEmail?: typeof sendRawEmail; now?: () => Date }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const env = getEnv();
  if ((env.EMAIL_PROVIDER ?? 'disabled') === 'disabled' && !deps?.sendEmail) return;
  const now = deps?.now?.() ?? new Date();
  // Historical resolved, seat and accepted rows do not consume the budget.
  await prisma.$executeRaw`
    INSERT INTO billing_commercial_email_deliveries(id,notification_id,recipient_user_id,next_attempt_at)
    SELECT gen_random_uuid()::text,n.id,m.user_id,${now}
    FROM billing_commercial_notifications n
    JOIN billing_commercial_incidents i ON i.id=n.incident_id
    JOIN org_members m ON m.org_id=i.org_id AND m.status='ACTIVE' AND m.role IN('owner','admin')
    JOIN users u ON u.id=m.user_id AND u.lifecycle_status='ACTIVE'
    WHERE i.resolved_at IS NULL AND i.category IN('phone','addon')
      AND (i.category<>'phone' OR EXISTS(SELECT 1 FROM billing_sms_number_resources r WHERE r.id=i.resource_id AND r.state<>'ended'))
      AND n.stage IN('initial','reminder','final_warning') AND n.due_at<=${now}
      AND NOT EXISTS(SELECT 1 FROM billing_commercial_acknowledgements a
        WHERE a.notification_id=n.id AND a.recipient_user_id=m.user_id AND a.channel='email')
      AND NOT EXISTS(SELECT 1 FROM billing_commercial_email_deliveries d
        WHERE d.notification_id=n.id AND d.recipient_user_id=m.user_id)
    ORDER BY n.due_at,n.id,m.user_id LIMIT 100 ON CONFLICT DO NOTHING`;
  const pending = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT d.id FROM billing_commercial_email_deliveries d
    JOIN billing_commercial_notifications n ON n.id=d.notification_id
    JOIN billing_commercial_incidents i ON i.id=n.incident_id
    JOIN org_members m ON m.org_id=i.org_id AND m.user_id=d.recipient_user_id
      AND m.status='ACTIVE' AND m.role IN('owner','admin')
    JOIN users u ON u.id=m.user_id AND u.lifecycle_status='ACTIVE'
    WHERE d.accepted_at IS NULL AND d.next_attempt_at<=${now} AND i.resolved_at IS NULL
      AND (i.category<>'phone' OR EXISTS(SELECT 1 FROM billing_sms_number_resources r WHERE r.id=i.resource_id AND r.state<>'ended'))
      AND NOT EXISTS(SELECT 1 FROM billing_commercial_acknowledgements a
        WHERE a.notification_id=n.id AND a.recipient_user_id=m.user_id AND a.channel='email')
    ORDER BY d.next_attempt_at,d.id LIMIT 100`;
  for (const item of pending) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM billing_commercial_email_deliveries WHERE id=${item.id} FOR UPDATE`;
        const delivery = await tx.billingCommercialEmailDelivery.findUniqueOrThrow({ where: { id: item.id } });
        if (delivery.acceptedAt || delivery.nextAttemptAt > now) return;
        const stage = await tx.billingCommercialNotification.findUniqueOrThrow({ where: { id: delivery.notificationId } });
        await tx.$queryRaw`SELECT id FROM billing_commercial_incidents WHERE id=${stage.incidentId} FOR SHARE`;
        const incident = await tx.billingCommercialIncident.findUniqueOrThrow({ where: { id: stage.incidentId } });
        await tx.$queryRaw`SELECT id FROM org_members WHERE org_id=${incident.orgId}
          AND user_id=${delivery.recipientUserId} FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM users WHERE id=${delivery.recipientUserId} FOR SHARE`;
        const member = await tx.orgMember.findFirst({ where: { orgId: incident.orgId,
          userId: delivery.recipientUserId, status: 'ACTIVE', role: { in: ['owner', 'admin'] },
          user: { lifecycleStatus: 'ACTIVE' } }, include: { user: true } });
        if (incident.resolvedAt || !member?.user.email) return;
        const key = { serviceId: incident.serviceId, notificationId: stage.id,
          channel: 'email', recipientUserId: delivery.recipientUserId };
        if (await tx.billingCommercialAcknowledgement.findUnique({ where: {
          serviceId_notificationId_channel_recipientUserId: key,
        } })) return;
        if (!env.EMAIL_FROM) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_NOTIFICATION_EMAIL_UNAVAILABLE');
        const service = await tx.billingService.findUniqueOrThrow({ where: { id: incident.serviceId } });
        const enrollment = await tx.billingProductEnrollment.findUniqueOrThrow({ where: {
          serviceId_orgId: { serviceId: incident.serviceId, orgId: incident.orgId },
        } });
        const keys = await tx.billingAppKey.findMany({ where: { serviceId: incident.serviceId,
          purpose: 'CUSTOMER_LIFECYCLE', revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
        const origins = new Set(keys.filter((key) => {
          const issuer = new URL(key.actorIssuer);
          return `${issuer.host}${issuer.pathname.replace(/\/$/, '')}` === enrollment.sourceDomain;
        }).flatMap((key) => key.checkoutReturnOrigins));
        const origin = [...origins][0];
        if (origins.size !== 1 || !origin) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_RECOVERY_ORIGIN_UNRESOLVED');
        const resource = incident.resourceId ? await tx.billingSmsNumberResource.findUnique({ where: { id: incident.resourceId } }) : null;
        if (incident.category === 'phone' && (!resource || resource.state === 'ended')) return;
        const addon = incident.addonSubscriptionId ? await tx.billingRecurringAddonSubscription.findUnique({
          where: { id: incident.addonSubscriptionId }, include: { offer: true } }) : null;
        const subject = resource ? `Phone number ${resource.phoneNumber}` : addon?.offer.name ?? `${service.name} add-on`;
        const recovery = new URL('/admin/billing', origin).toString();
        const identity = createHash('sha256').update(delivery.id).digest('hex');
        const messageId = `<uoa-commercial-${identity}@${new URL(recovery).hostname}>`;
        await (deps?.sendEmail ?? sendRawEmail)({ to: member.user.email, from: env.EMAIL_FROM, messageId,
          subject: `${stage.stage === 'final_warning' ? 'Final payment warning' : 'Payment needs attention'}: ${subject}`,
          text: `${subject} recurring payment failed. Recover payment: ${recovery}\n` +
            (stage.stage === 'final_warning'
              ? `Original payment deadline: ${incident.graceEndsAt.toISOString()}. ` +
                'Your service remains available for at least 24 hours after this final warning is delivered. Recover payment now to keep it.'
              : `Recover payment by ${incident.graceEndsAt.toISOString()} to keep this service.`) });
        const acceptedAt = deps?.now?.() ?? new Date();
        await tx.billingCommercialAcknowledgement.create({ data: { ...key,
          receiptId: `email-transport-accepted:${delivery.id}`, acknowledgedAt: acceptedAt } });
        await tx.billingCommercialEmailDelivery.update({ where: { id: delivery.id }, data: { acceptedAt } });
      }, { timeout: 30_000 });
    } catch {
      // Persist a fair retry slot. Other recipients continue without fake receipts.
      await prisma.billingCommercialEmailDelivery.updateMany({ where: { id: item.id, acceptedAt: null },
        data: { attemptCount: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + 300_000) } });
    }
  }
}
