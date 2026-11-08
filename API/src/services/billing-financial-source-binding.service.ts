import { Prisma,type PrismaClient } from '@prisma/client';
import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { resolveOrganisationBillingMode } from './billing-organisation-mode.service.js';

/** Capture forward financial authority under the same org/mode write fence.
 * Read/replay callers use their stored binding instead; no historical backfill. */
export async function captureOrganisationFinancialSource(tx:Prisma.TransactionClient,orgId:string) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations WHERE id=${orgId} AND lifecycle_status='ACTIVE' FOR SHARE`);
  await tx.$executeRaw(Prisma.sql`INSERT INTO billing_organisation_mode_locks(org_id) VALUES(${orgId})
    ON CONFLICT(org_id) DO UPDATE SET generation=billing_organisation_mode_locks.generation+1`);
  const selection=await resolveOrganisationBillingMode(orgId,tx);const env=getEnv();
  const stripeAccountId=selection.mode==='live'?env.STRIPE_LIVE_ACCOUNT_ID:env.STRIPE_SANDBOX_ACCOUNT_ID;
  if(!stripeAccountId)throw new AppError('SERVICE_UNAVAILABLE',503,'BILLING_STRIPE_MODE_NOT_CONFIGURED');
  const account=await tx.billingStripeAccount.findUnique({where:{stripeAccountId_livemode:{stripeAccountId,livemode:selection.mode==='live'}}});
  if(!account)throw new AppError('SERVICE_UNAVAILABLE',503,'BILLING_STRIPE_ACCOUNT_NOT_CONFIGURED');
  return {billingAccountId:account.id,billingScopeEpoch:new Date(selection.epoch),billingModeRevision:selection.revision};
}

export async function assertCurrentFinancialSource(tx:Prisma.TransactionClient,source:{orgId:string;billingAccountId:string|null;
  billingScopeEpoch:Date|null;billingModeRevision:number|null}) {
  const selection=await resolveOrganisationBillingMode(source.orgId,tx);
  const env=getEnv();const named=selection.mode==='live'?env.STRIPE_LIVE_ACCOUNT_ID:env.STRIPE_SANDBOX_ACCOUNT_ID;
  const account=source.billingAccountId?await tx.billingStripeAccount.findUnique({where:{id:source.billingAccountId}}):null;
  if(!account||!named||account.stripeAccountId!==named||source.billingScopeEpoch?.toISOString()!==selection.epoch||source.billingModeRevision!==selection.revision||
    account.livemode!==(selection.mode==='live'))throw new AppError('BAD_REQUEST',409,'BILLING_FINANCIAL_SOURCE_RECONCILIATION_REQUIRED');
}

export async function assertPaidFinancialSources(reader:PrismaClient|Prisma.TransactionClient,
  scope:{serviceId:string;organisationId:string;teamId:string;billingMonth:string},accountId:string) {
  const rows=await reader.$queryRaw<Array<{unknown:boolean;different:boolean}>>(Prisma.sql`
    SELECT bool_or(COALESCE(b.billing_account_id,w.account_id) IS NULL) AS unknown,
      bool_or(COALESCE(b.billing_account_id,w.account_id)<>${accountId}) AS different
    FROM billing_paid_usage_liabilities l LEFT JOIN billing_credit_budget_dispatches b ON b.dispatch_id=l.dispatch_id
    LEFT JOIN billing_credit_accounts w ON w.id=l.credit_account_id AND w.org_id=l.org_id
    WHERE l.org_id=${scope.organisationId} AND l.team_id=${scope.teamId} AND l.service_id=${scope.serviceId}
      AND l.billing_month=${scope.billingMonth} AND NOT (COALESCE(b.tariff_mode,'')='FREE' AND l.rated_microcredits=0)`);
  if(rows[0]?.unknown)throw new AppError('BAD_REQUEST',409,'BILLING_CAPTURED_ACCOUNT_RECONCILIATION_REQUIRED');
  if(rows[0]?.different)throw new AppError('BAD_REQUEST',409,'BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH');
}
