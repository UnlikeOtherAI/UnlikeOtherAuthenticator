import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { sendRawEmail } from './email.service.js';
import { listSuperuserEmailsInAdminDomain } from './integration-request-notify.service.js';

export type SmsPolicyAlertKind = 'fx_unavailable' | 'fx_outside_band' | 'fx_no_baseline' |
  'route_needs_operator' | 'route_price_rose' | 'route_price_unavailable' | 'monthly_price_below_cost';
export type SmsPolicyAlertCondition = { kind: SmsPolicyAlertKind; subject: string; message: string };
export type SmsPolicyAlertLog = { error: (details: object, message: string) => void };
type AlertDb = Pick<PrismaClient, 'billingSmsPolicyAlert'>;

/** The FX subject; route subjects are `account:country:direction:currency`. */
export const SMS_FX_ALERT_SUBJECT = 'ECB_REFERENCE_USD_PER_EUR_V1';
export function smsRouteAlertSubject(route: {
  accountSid: string; country: string; direction: string; currency: string;
}): string {
  return `${route.accountSid}:${route.country}:${route.direction}:${route.currency}`;
}

/**
 * Open a condition once. A concurrent or repeated detection only refreshes the
 * open row, so the caller notifies operators exactly when this returns true.
 */
export async function raiseSmsPolicyAlert(db: AlertDb, condition: SmsPolicyAlertCondition, now: Date): Promise<boolean> {
  try {
    await db.billingSmsPolicyAlert.create({ data: { ...condition, openedAt: now, lastSeenAt: now } });
    return true;
  } catch (error) {
    // The partial unique index admits one open alert per kind and subject.
    if ((error as { code?: unknown })?.code !== 'P2002') throw error;
  }
  await db.billingSmsPolicyAlert.updateMany({
    where: { kind: condition.kind, subject: condition.subject, resolvedAt: null },
    data: { message: condition.message, lastSeenAt: now },
  });
  return false;
}

/** Close a subject's open alerts, except the kind still observed in this run. */
export async function resolveSmsPolicyAlerts(db: AlertDb, subject: string, now: Date,
  stillOpen?: SmsPolicyAlertKind): Promise<void> {
  await db.billingSmsPolicyAlert.updateMany({
    where: { subject, resolvedAt: null, ...(stillOpen ? { kind: { not: stillOpen } } : {}) },
    data: { resolvedAt: now },
  });
}

export async function listOpenSmsPolicyAlerts(db: AlertDb) {
  const rows = await db.billingSmsPolicyAlert.findMany({
    where: { resolvedAt: null }, orderBy: { openedAt: 'desc' }, take: 50,
  });
  return rows.map((row) => ({ id: row.id, kind: row.kind, subject: row.subject, message: row.message,
    opened_at: row.openedAt.toISOString(), last_seen_at: row.lastSeenAt.toISOString() }));
}

/** Email every admin-domain superuser through the existing sender; failures are logged, never thrown. */
export async function emailSmsPolicyAlert(condition: SmsPolicyAlertCondition, log: SmsPolicyAlertLog): Promise<void> {
  const env = getEnv();
  if (!env.EMAIL_FROM) {
    log.error({ kind: condition.kind }, 'SMS policy alert email skipped: EMAIL_FROM is not configured');
    return;
  }
  let recipients: string[];
  try {
    recipients = await listSuperuserEmailsInAdminDomain();
  } catch (err) {
    log.error({ err, kind: condition.kind }, 'failed to resolve SMS policy alert recipients');
    return;
  }
  const base = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  const where = base ? `${base}/admin/billing?section=sms` : 'Admin > Billing > SMS policies';
  await Promise.all(recipients.map(async (to) => {
    try {
      await sendRawEmail({ to, from: env.EMAIL_FROM as string, subject: 'UOA SMS pricing policy needs attention',
        text: `${condition.message}\n\nReview it in Admin > Billing > SMS policies: ${where}\n` });
    } catch (err) {
      log.error({ err, kind: condition.kind }, 'failed to send SMS policy alert email');
    }
  }));
}
