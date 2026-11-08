import { Prisma,type PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

export function organisationBillingPeriod(month:string,now:Date) {
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw new AppError('BAD_REQUEST',400,'BILLING_MONTH_INVALID');
  const start=new Date(`${month}-01T00:00:00.000Z`);
  const end=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1));
  if(start>now)throw new AppError('BAD_REQUEST',400,'BILLING_MONTH_FUTURE');
  return {month,start,end,asOf:new Date(Math.min(now.getTime(),end.getTime()))};
}

/** Read-side evidence only. The collection guard and its write fence remain separate. */
export async function assertOrganisationBillPeriod(prisma:PrismaClient,
  input:{organisationId:string;accountId:string;month:string;now:Date}) {
  const period=organisationBillingPeriod(input.month,input.now);
  const rows=await prisma.$queryRaw<Array<{epoch:Date;transition:boolean;mismatch:boolean}>>(Prisma.sql`
    SELECT c.activated_at AS epoch,
      (c.activated_at>=${period.start} AND c.activated_at<${period.end} OR EXISTS(
        SELECT 1 FROM billing_organisation_mode_events e WHERE e.org_id=${input.organisationId}
          AND e.effective_at>=${period.start} AND e.effective_at<${period.end})) AS transition,
      (COALESCE((SELECT sandbox FROM billing_organisation_mode_events WHERE org_id=${input.organisationId}
        AND effective_at<=${period.start} ORDER BY revision DESC LIMIT 1),false)=
          (SELECT livemode FROM billing_stripe_accounts WHERE id=${input.accountId})
        OR EXISTS(SELECT 1 FROM billing_credit_usage_settlements u JOIN billing_credit_accounts a ON a.id=u.credit_account_id
        WHERE a.org_id=${input.organisationId} AND u.billing_month=${input.month} AND u.account_id<>${input.accountId})
        OR EXISTS(SELECT 1 FROM billing_stripe_usage_exports u JOIN billing_stripe_subscriptions s ON s.id=u.subscription_id
          WHERE s.org_id=${input.organisationId} AND u.billing_month=${input.month} AND u.account_id<>${input.accountId})) AS mismatch
    FROM billing_organisation_scope_cutover c WHERE c.id=1`);
  const evidence=rows[0];
  if(!evidence)throw new AppError('SERVICE_UNAVAILABLE',503,'BILLING_ORGANISATION_CUTOVER_NOT_INSTALLED');
  if(evidence.transition)throw new AppError('BAD_REQUEST',409,'BILLING_MODE_TRANSITION_RECONCILIATION_REQUIRED');
  if(period.end<=evidence.epoch)throw new AppError('BAD_REQUEST',409,'BILLING_ORGANISATION_HISTORY_RECONCILIATION_REQUIRED');
  if(evidence.mismatch)throw new AppError('BAD_REQUEST',409,'BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH');
  return period;
}
