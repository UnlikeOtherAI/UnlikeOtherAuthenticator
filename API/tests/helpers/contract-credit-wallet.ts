import { BillingAssignmentScope,BillingCreditEntryDirection,BillingCreditEntryKind,Prisma,type PrismaClient } from '@prisma/client';
export async function createContractCreditWallet(prisma:PrismaClient,accountId:string,orgId:string,owner:{id:string;email:string},adminDomain:string) {
    const stripeAccount=await prisma.billingStripeAccount.findUniqueOrThrow({where:{id:accountId}});
    const customer = await prisma.billingStripeCustomer.create({
      data: {
        accountId: stripeAccount.id,
        orgId: orgId,
        teamId: null,
        scope: BillingAssignmentScope.ORGANISATION,
        scopeKey: orgId,
        stripeCustomerId: 'cus_credit_contract_test',
      },
    });
    const creditAccount = await prisma.billingCreditAccount.create({
      data: {
        accountId: stripeAccount.id,
        customerId: customer.id,
        orgId: orgId,
        teamId: null,scope:BillingAssignmentScope.ORGANISATION,
        scopeKey: orgId,
        currency: 'USD',
      },
    });

    const fundingAdjustmentId = 'credit_contract_funding_adjustment';
    const fundingEntryId = 'credit_contract_funding_entry';
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.admin_auth_domain', ${adminDomain}, true)`,
      );
      await tx.billingCreditAdminAdjustment.create({
        data: {
          id: fundingAdjustmentId,
          accountId: stripeAccount.id,
          creditAccountId: creditAccount.id,
          orgId: orgId,
          teamId: null,
          signedAmountMicrocredits: 5_000_000_000n,
          reason: 'Contract invoice integration funding',
          idempotencyKey: 'credit-contract-funding',
          createdByUserId: owner.id,
          createdByEmail: owner.email,
          createdByAdminDomain: adminDomain,
          creditEntryId: fundingEntryId,
        },
      });
      await tx.billingCreditEntry.create({
        data: {
          id: fundingEntryId,
          creditAccountId: creditAccount.id,
          direction: BillingCreditEntryDirection.CREDIT,
          kind: BillingCreditEntryKind.ADJUSTMENT,
          amountMicrocredits: 5_000_000_000n,
          balanceAfterMicrocredits: 5_000_000_000n,
          currency: 'USD',
          idempotencyKey: 'credit-contract-funding',
          sourceType: 'credit_admin_adjustment',
          sourceId: fundingAdjustmentId,
          occurredAt: new Date('2030-06-30T23:00:00.000Z'),
        },
      });
    });

  return {stripeAccount,creditAccount};
}
