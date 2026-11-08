import type { PrismaClient } from '@prisma/client';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { createRlsTestDb } from '../helpers/test-db.js';
import { getAdminAuthDomain } from '../../src/config/env.js';
import { captureOrganisationFinancialSource,assertCurrentFinancialSource } from '../../src/services/billing-financial-source-binding.service.js';
import { createBillingContract } from '../../src/services/billing-contract.service.js';
import { createCommercialAdjustment,deactivateCommercialAdjustment,listApplicableCommercialAdjustments } from '../../src/services/billing-commercial-adjustment.service.js';
import { setOrganisationBillingMode } from '../../src/services/billing-organisation-mode.service.js';
import { paidUsageRatingScopeKey } from '../../src/services/billing-paid-liability.service.js';

describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS!=='true')('forward financial source binding',()=>{
  let db:PrismaClient,cleanup:()=>Promise<void>;const actor={userId:'binding-owner',email:'binding@example.test',tokenVersion:0};
  beforeAll(async()=>{
    const handle=await createRlsTestDb();if(!handle)throw Error('Disposable PG required');db=handle.prisma;cleanup=handle.cleanup;
    for(const mode of ['LIVE','SANDBOX']){
      vi.stubEnv(`STRIPE_${mode}_ACCOUNT_ID`,'acct_FinancialMain');vi.stubEnv(`STRIPE_${mode}_SECRET_KEY`,mode==='LIVE'?'rk_live_fixture':'rk_test_fixture');
      vi.stubEnv(`STRIPE_${mode}_WEBHOOK_SECRET`,'whsec_fixture_'+mode);
    }
    await db.user.create({data:{id:actor.userId,email:actor.email,userKey:actor.email}});
    await db.domainRole.create({data:{domain:getAdminAuthDomain(),userId:actor.userId,role:'SUPERUSER'}});
    await db.organisation.create({data:{id:'binding-org',domain:'binding.example.test',name:'Binding',slug:'binding',ownerId:actor.userId}});
    await db.orgMember.create({data:{orgId:'binding-org',userId:actor.userId,role:'owner'}});
    await db.team.create({data:{id:'binding-team',orgId:'binding-org',name:'Team',slug:'team'}});
    await db.billingService.create({data:{id:'binding-service',identifier:'binding',name:'Binding'}});
    await db.billingTariff.create({data:{id:'binding-tariff',serviceId:'binding-service',key:'standard',version:1,name:'Standard',
      mode:'STANDARD',collectionMode:'STRIPE',markupBps:3000,monthlyAmountMinor:0n,currency:'USD'}});
    await db.billingStripeAccount.createMany({data:[{id:'binding-live',stripeAccountId:'acct_FinancialMain',livemode:true},
      {id:'binding-test',stripeAccountId:'acct_FinancialMain',livemode:false}]});
  });
  afterAll(async()=>{await cleanup?.();vi.unstubAllEnvs();});
  const data=(id:string)=>({dispatchId:id,contextDigest:'a'.repeat(64),serviceId:'binding-service',providerServiceId:'provider',
    orgId:'binding-org',teamId:'binding-team',userId:actor.userId,billingMonth:new Date().toISOString().slice(0,7),
    currency:'USD',tariffId:'binding-tariff',frozenMarkupBps:3000,tariffMode:'STANDARD',paymentMode:'PAY_AS_YOU_GO',reservedMicrocredits:100n});
  it('captures the named account and immutable epoch; direct unbound or other-mode capture refuses',async()=>{
    const row=await db.$transaction(async tx=>tx.billingCreditBudgetDispatch.create({data:{...data('bound-live'),
      ...await captureOrganisationFinancialSource(tx,'binding-org')}}));
    expect(row.billingAccountId).toBe('binding-live');expect(row.billingScopeEpoch).toBeInstanceOf(Date);expect(row.billingModeRevision).toBe(0);
    await expect(db.billingCreditBudgetDispatch.create({data:data('unbound')})).rejects.toThrow('BILLING_CAPTURED_ACCOUNT_RECONCILIATION_REQUIRED');
    await expect(db.billingCreditBudgetDispatch.create({data:{...data('wrong'),billingAccountId:'binding-test',
      billingScopeEpoch:row.billingScopeEpoch,billingModeRevision:0}})).rejects.toThrow('BILLING_CONTEXT_STALE');
    await expect(db.billingCreditBudgetDispatch.update({where:{dispatchId:row.dispatchId},data:{billingAccountId:'binding-test'}}))
      .rejects.toThrow('BILLING_FINANCIAL_SOURCE_BINDING_IMMUTABLE');
    await expect(setOrganisationBillingMode({organisationId:'binding-org',mode:'sandbox',expectedRevision:0,actor},db))
      .rejects.toThrow('BILLING_ORGANISATION_MODE_BLOCKED');
    await db.billingCreditBudgetDispatch.update({where:{dispatchId:row.dispatchId},data:{status:'RELEASED',terminalAt:new Date()}});
  });
  it('binds new manual contracts/adjustments without changing their history or invoking a provider',async()=>{
    const contract=await createBillingContract({organisationId:'binding-org',name:'Manual',reference:'manual',actor},{prisma:db});
    expect(contract.billingAccountId).toBe('binding-live');
    const adjustment=await createCommercialAdjustment({organisationId:'binding-org',serviceId:'binding-service',teamId:'binding-team',
      key:'fee',name:'Fee',kind:'add_on',cadence:'monthly',amountMinor:'100',currency:'USD',startsAt:new Date(),createdBy:actor},{prisma:db});
    expect(adjustment.billingAccountId).toBe('binding-live');
    await expect(setOrganisationBillingMode({organisationId:'binding-org',mode:'sandbox',expectedRevision:0,actor},db))
      .rejects.toThrow('BILLING_ORGANISATION_MODE_BLOCKED');
    await deactivateCommercialAdjustment({serviceId:'binding-service',adjustmentId:adjustment.id,actor},{prisma:db});
    await setOrganisationBillingMode({organisationId:'binding-org',mode:'sandbox',expectedRevision:0,actor},db);
    const period=new Date(),startsAt=new Date(Date.UTC(period.getUTCFullYear(),period.getUTCMonth(),1)),
      endsAt=new Date(Date.UTC(period.getUTCFullYear(),period.getUTCMonth()+1,1)),read={serviceId:'binding-service',
      organisationId:'binding-org',teamId:'binding-team',startsAt,endsAt};
    expect((await listApplicableCommercialAdjustments({...read,accountId:'binding-live'},{prisma:db})).map(row=>row.id)).toEqual([adjustment.id]);
    expect(await listApplicableCommercialAdjustments({...read,accountId:'binding-test'},{prisma:db})).toEqual([]);
    await expect(db.$transaction(tx=>assertCurrentFinancialSource(tx,contract))).rejects.toThrow('BILLING_FINANCIAL_SOURCE_RECONCILIATION_REQUIRED');
    expect((await db.billingOrganisationContract.findUniqueOrThrow({where:{id:contract.id}})).billingAccountId).toBe('binding-live');
    await expect(db.billingCommercialAdjustment.delete({where:{id:adjustment.id}})).rejects.toThrow('BILLING_FINANCIAL_SOURCE_BINDING_IMMUTABLE');
    const captured=await db.$transaction(tx=>captureOrganisationFinancialSource(tx,'binding-org'));expect(captured.billingAccountId).toBe('binding-test');
    expect(await db.billingCreditEntry.count()).toBe(0);expect(await db.billingStripeWebhookEvent.count()).toBe(0);
  });
  it('keeps fractional PAYG rating buckets separate by captured account while prepaid keys stay stable',()=>{
    const base={orgId:'binding-org',teamId:'binding-team',currency:'USD'};
    expect(paidUsageRatingScopeKey({...base,billingAccountId:'binding-live'})).not.toBe(paidUsageRatingScopeKey({...base,billingAccountId:'binding-test'}));
    expect(paidUsageRatingScopeKey({...base,billingAccountId:'binding-live',creditAccountId:'original-wallet'})).toBe('prepaid:original-wallet');
  });
});
