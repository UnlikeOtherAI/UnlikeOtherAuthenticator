import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { seedOrganisationAddonInvoices } from '../helpers/organisation-addon-invoice-fixture.js';
import { handleStripeWebhook } from '../../src/services/billing-stripe-webhook.service.js';
import { prepareStripePaymentInvoice,persistStripePaymentInvoice } from '../../src/services/billing-stripe-payment-invoice-source.service.js';
import { issueStripePaymentInvoice } from '../../src/services/billing-stripe-payment-invoice-issue.service.js';
import { listCustomerInvoices,getCustomerInvoiceDetail,downloadCustomerInvoice } from '../../src/services/billing-customer-invoice-read.service.js';
import type { BillingCycleContext } from '../../src/services/billing-cycle-read.service.js';
import type { BillingInvoicePdfStorage } from '../../src/services/billing-invoice-storage.service.js';
import { readOrganisationAccruedBill } from '../../src/services/billing-organisation-accrual.service.js';
import { runAddonInvoiceRecoveryCycle } from '../../src/services/billing-addon-invoice-recovery.service.js';
import { collectContractFundingEvidence } from '../../src/services/billing-contract-funding-evidence.service.js';
vi.mock('../../src/services/billing-actor.service.js',()=>({verifyBillingActor:async()=>({})}));
describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS!=='true')('actual add-on invoice financial sources',()=>{
  let handle:NonNullable<Awaited<ReturnType<typeof createTestDb>>>,seed:Awaited<ReturnType<typeof seedOrganisationAddonInvoices>>;
  let context:BillingCycleContext;const objects=new Map<string,Buffer>(),pdf=Buffer.from('%PDF-1.7\naddon\n%%EOF');
  const storage:BillingInvoicePdfStorage={putImmutable:async(key,bytes)=>{if(objects.has(key))throw Error('IMMUTABLE');objects.set(key,Buffer.from(bytes));},
    read:async key=>{const bytes=objects.get(key);if(!bytes)throw Error('MISSING');return bytes;}};
  beforeAll(async()=>{
    const db=await createTestDb();if(!db)throw Error('Disposable PG required');handle=db;seed=await seedOrganisationAddonInvoices(db.prisma);
    for(const mode of ['LIVE','SANDBOX']){
      vi.stubEnv(`STRIPE_${mode}_ACCOUNT_ID`,seed.account.stripeAccountId);vi.stubEnv(`STRIPE_${mode}_SECRET_KEY`,mode==='LIVE'?'rk_live_fixture':'rk_test_fixture');
      vi.stubEnv(`STRIPE_${mode}_WEBHOOK_SECRET`,'whsec_fixture_'+mode);
    }
    context={credential:seed.credential as never,actorToken:'verified',endpoint:'/billing/v1/invoices/list',financialScope:'organisation',billingMode:'live',
      request:{product:'control',organisationId:'control-org',teamId:'control-team',userId:'control-owner'}};
  });
  afterAll(async()=>{await handle?.cleanup();vi.unstubAllEnvs();});
  it('captures each actual payment once with its add-on source and ORG payer, without a base subscription',async()=>{
    for(let index=0;index<seed.sources.length;index++){
      seed.setEvent(index);const params={rawBody:Buffer.from('{}'),signature:'verified-synthetic-provider-boundary'},deps={prisma:handle.prisma,
        stripe:seed.stripe,webhookSecret:'fixture',stripeLivemode:true,collectionEnabled:false};
      expect(await handleStripeWebhook(params,deps)).toEqual({duplicate:false});
      expect(await handleStripeWebhook(params,deps)).toEqual({duplicate:true});
      const source=seed.sources[index]!,row=await handle.prisma.billingStripePaymentInvoice.findFirstOrThrow({where:{stripeInvoiceId:source.invoice.id},
        include:{cashPayments:true,lines:true}});
      expect(row).toMatchObject({subscriptionId:null,addonSubscriptionId:source.subscription.id,orgId:'control-org',teamId:null,
        accountId:seed.account.id,livemode:true,grossAmountMinor:5000n,paidAmountMinor:5000n});
      expect(row.cashPayments).toHaveLength(1);expect(row.lines[0]?.billingMonth).toBe('2030-01');
      await issueStripePaymentInvoice(row.id,{prisma:handle.prisma,stripe:seed.stripe,account:seed.account,storage,
        download:async()=>new Response(pdf)});
    }
    expect(await handle.prisma.billingStripeSubscription.count()).toBe(0);
    expect(await handle.prisma.billingStripePaymentInvoice.count()).toBe(2);expect(await handle.prisma.billingStripePaymentInvoiceCashPayment.count()).toBe(2);
    expect(await handle.prisma.billingCreditEntry.count()).toBe(0);
  });
  it('selects genuine add-on funding evidence by the exact captured provider account across both entitlement teams',async()=>{
    const p=handle.prisma,tariff=await p.billingTariff.create({data:{serviceId:'control-service',key:'manual-proof',version:1,
      name:'Manual',mode:'CUSTOM',collectionMode:'MANUAL',markupBps:3000,currency:'USD',monthlyAmountMinor:1000n}});
    const input={serviceId:'control-service',tariffId:tariff.id,organisationId:'control-org',billingMonth:'2030-01',
      startsAt:new Date('2030-01-01'),endsAt:new Date('2030-02-01')};
    const live=await collectContractFundingEvidence({...input,accountId:seed.account.id},{prisma:p});
    expect(live.addons.map(row=>row.subscriptionId).sort()).toEqual(seed.sources.map(row=>row.subscription.id).sort());
    expect(await collectContractFundingEvidence({...input,accountId:'control-test'},{prisma:p})).toEqual({credits:[],addons:[]});
    expect(await p.billingCreditEntry.count()).toBe(0);expect(await p.billingRecurringAddonSubscription.count()).toBe(2);
  });
  it('reads financial history for both entitlement teams and downloads the exact captured PDF',async()=>{
    const p=handle.prisma;
    await expect(listCustomerInvoices(context,{chargeMonth:'2030-01'},{prisma:p})).rejects.toThrow('BILLING_ADDON_HISTORY_RECONCILIATION_REQUIRED');
    const known=await p.billingStripePaymentInvoice.findFirstOrThrow();
    expect((await getCustomerInvoiceDetail(context,`stripe:${known.id}`,{prisma:p})).document_available).toBe(true);
    for(let index=0;index<2;index++)expect(await runAddonInvoiceRecoveryCycle({prisma:p,now:()=>new Date('2030-01-08'),
      runtime:async()=>({client:seed.stripe,livemode:true,webhookSecret:'fixture'})})).toMatchObject({completed:1,held:0});
    const list=await listCustomerInvoices(context,{chargeMonth:'2030-01'},{prisma:p});
    expect(list.invoices).toHaveLength(2);expect(list.invoices.every(row=>row.scope.scope_type==='organisation'&&row.scope.team_id===null)).toBe(true);
    const id=list.invoices[0]!.invoice_id,detail=await getCustomerInvoiceDetail(context,id,{prisma:p});
    expect(detail.charges[0]?.label).toBe('Private research');expect(detail.totals.total_paid.amount_minor).toBe('5000');
    expect((await downloadCustomerInvoice(context,id,id,{prisma:p,storage})).bytes).toEqual(pdf);
    expect((await listCustomerInvoices({...context,billingMode:'sandbox'},{chargeMonth:'2030-01'},{prisma:p})).invoices).toEqual([]);
    await expect(getCustomerInvoiceDetail({...context,billingMode:'sandbox'},id,{prisma:p})).rejects.toMatchObject({statusCode:404});
  });
  it('confirms both ORG-paid entitlement targets in accrued money and holds a missing subsequent period',async()=>{
    const bill=await readOrganisationAccruedBill({request:context.request} as never,seed.selection,'2030-01',
      new Date('2030-01-08T00:00:00Z'),handle.prisma);
    expect(bill.lines.filter(line=>line.kind==='add_on')).toHaveLength(2);
    expect(bill.totals).toMatchObject([{currency:'USD',subscription:{amount_minor:'10000'},
      total_paid:{amount_minor:'10000'},outstanding:{amount_minor:'0'}}]);
    await expect(readOrganisationAccruedBill({request:context.request} as never,seed.selection,'2030-02',
      new Date('2030-02-08T00:00:00Z'),handle.prisma)).rejects.toThrow('BILLING_ACCRUAL_ADDON_RECONCILIATION_REQUIRED');
  });
  it('refuses another account/mode or a second subscription identity at capture and keeps existing sources immutable',async()=>{
    const p=handle.prisma,source=seed.sources[0]!,prepared=await prepareStripePaymentInvoice(source.invoice.id,seed.account,p,seed.stripe);
    expect(prepared).toBeTruthy();expect(prepared!.facts.subscriptionId).toBeNull();
    await expect(p.$transaction(tx=>persistStripePaymentInvoice(tx,{...prepared!,facts:{...prepared!.facts,
      accountId:'control-test',livemode:false,stripeInvoiceId:'in_wrong_binding'}}))).rejects.toThrow('STRIPE_INVOICE_SUBSCRIPTION_BINDING_INVALID');
    const row=await p.billingStripePaymentInvoice.findFirstOrThrow({where:{stripeInvoiceId:source.invoice.id}});
    await expect(p.billingStripePaymentInvoice.update({where:{id:row.id},data:{addonSubscriptionId:seed.sources[1]!.subscription.id}}))
      .rejects.toThrow('Stripe payment invoice source is immutable');
    expect(await p.billingStripePaymentInvoice.count()).toBe(2);
  });
});
