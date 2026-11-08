import { Prisma,type PrismaClient } from '@prisma/client';
import { captureOrganisationFinancialSource } from '../../src/services/billing-financial-source-binding.service.js';
import { reserveBudgetDispatch } from '../../src/services/billing-credit-budget-dispatch.service.js';
import { configureSyntheticStripeMode } from './stripe-mode-config.js';

/** Fresh LIVE organisation source, captured through the production write fence.
 * No historical source is modified. No Stripe transport is constructed. */
export async function captureTestOrganisationFinancialBinding(prisma:PrismaClient,orgId:string,
  account={stripeAccountId:'acct_LocalManualFixture',livemode:true}) {
  const {stripeAccountId,livemode}=account;
  configureSyntheticStripeMode(stripeAccountId,livemode);
  await prisma.billingStripeAccount.upsert({where:{stripeAccountId_livemode:{stripeAccountId,livemode}},
    create:{stripeAccountId,livemode},update:{}});
  return prisma.$transaction(tx=>captureOrganisationFinancialSource(tx,orgId));
}

export async function createTestSandboxOrganisationPolicy(prisma:PrismaClient,orgId:string) {
  await prisma.$transaction(async tx=>{
    await tx.billingOrganisationMode.create({data:{orgId,sandbox:true,revision:1}});
  });
  return (await prisma.billingOrganisationScopeCutover.findUniqueOrThrow({where:{id:1}})).activatedAt;
}

/** Allocation/correction fixtures supply their exact frozen liability. Capture
 * its source first with the real runtime fence instead of fabricating an
 * unbound PAYG receipt. Runtime rating itself has separate persistence tests. */
export async function createTestCapturedPaidLiability(prisma:PrismaClient,
  args:{data:Prisma.BillingPaidUsageLiabilityUncheckedCreateInput}) {
  const data=args.data;
  if(data.paymentMode!=='PREPAID'&&data.paymentMode!=='PAY_AS_YOU_GO')throw new Error('TEST_PAYMENT_MODE_REQUIRED');
  const paymentMode=data.paymentMode;
  const service=await prisma.billingService.findUniqueOrThrow({where:{id:data.serviceId}});
  return prisma.$transaction(async tx=>{
    await reserveBudgetDispatch(tx,{dispatchId:data.dispatchId,requestFingerprint:'a'.repeat(64),
      startedAt:new Date(`${data.billingMonth}-01T00:00:00Z`),product:service.identifier,serviceId:data.serviceId,
      providerServiceId:data.providerServiceId,orgId:data.orgId,teamId:data.teamId,userId:data.userId,
      billingMonth:data.billingMonth,currency:data.currency,tariffId:data.tariffId,tariffMode:'CUSTOM',
      markupBps:data.frozenMarkupBps,paymentMode,
      rawCostBound:new Prisma.Decimal(data.rawCostActual.toString()),context:null});
    return tx.billingPaidUsageLiability.create(args);
  });
}
