import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { seedOrganisationAddonInvoices } from '../helpers/organisation-addon-invoice-fixture.js';
import { runAddonInvoiceRecoveryCycle,assertAddonInvoiceHistoryComplete } from '../../src/services/billing-addon-invoice-recovery.service.js';
import { stripeRuntimeForAccount,resetStripeClientCache,requireStripeWebhookConfigured } from '../../src/services/billing-stripe-client.service.js';
import { handleStripeWebhook } from '../../src/services/billing-stripe-webhook.service.js';
import { listCustomerInvoices,getCustomerInvoiceDetail } from '../../src/services/billing-customer-invoice-read.service.js';
import type { BillingCycleContext } from '../../src/services/billing-cycle-read.service.js';
import { runAddonInvoiceRecoveryCommand } from '../../src/cli/recover-addon-invoices.js';
vi.mock('../../src/services/billing-actor.service.js',()=>({verifyBillingActor:async()=>({})}));
type Db=NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
type Seed=Awaited<ReturnType<typeof seedOrganisationAddonInvoices>>;
const at=new Date('2030-01-08T00:00:00Z'),later=new Date('2030-01-08T01:00:00Z');
function context(seed:Seed):BillingCycleContext{return {credential:seed.credential as never,actorToken:'verified',endpoint:'/billing/v1/invoices/list',
  financialScope:'organisation',billingMode:'live',request:{product:'control',organisationId:'control-org',teamId:'control-team',userId:'control-owner'}};}
function configure(){
  vi.stubEnv('STRIPE_BILLING_ENABLED','false');vi.stubEnv('STRIPE_SECRET_KEY','rk_test_expired');vi.stubEnv('STRIPE_WEBHOOK_SECRET','whsec_legacy');
  for(const mode of ['LIVE','SANDBOX']){
    vi.stubEnv(`STRIPE_${mode}_ACCOUNT_ID`,'acct_Controls');vi.stubEnv(`STRIPE_${mode}_SECRET_KEY`,mode==='LIVE'?'rk_live_recovery':'rk_test_fresh');
    vi.stubEnv(`STRIPE_${mode}_WEBHOOK_SECRET`,`whsec_${mode}`);
  }
}
function namedClient(seed:Seed){
  const client=stripeRuntimeForAccount(seed.account).client;
  vi.spyOn(client.accounts,'retrieveCurrent').mockImplementation(seed.stripe.accounts.retrieveCurrent as never);
  vi.spyOn(client.invoices,'list').mockImplementation(seed.stripe.invoices.list as never);
  vi.spyOn(client.invoices,'retrieve').mockImplementation(seed.stripe.invoices.retrieve as never);
  vi.spyOn(client.subscriptions,'retrieve').mockImplementation(seed.stripe.subscriptions.retrieve as never);
  vi.spyOn(client.invoicePayments,'list').mockImplementation(seed.stripe.invoicePayments.list as never);
  vi.spyOn(client.paymentIntents,'retrieve').mockImplementation(seed.stripe.paymentIntents.retrieve as never);
  vi.spyOn(client.charges,'retrieve').mockImplementation(seed.stripe.charges.retrieve as never);
  return client;
}
describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS!=='true')('original add-on invoice recovery',()=>{
  let db:Db,seed:Seed,before:unknown,client:ReturnType<typeof namedClient>;
  beforeAll(async()=>{
    const handle=await createTestDb();if(!handle)throw Error('Disposable PG required');db=handle;seed=await seedOrganisationAddonInvoices(db.prisma);
    configure();client=namedClient(seed);before=await db.prisma.billingRecurringAddonSubscription.findMany({orderBy:{id:'asc'}});
    const a=seed.sources[0]!,older={...a,suffix:'a_older',invoice:{...a.invoice,id:'in_addon_a_older',created:Date.parse('2029-12-01')/1000,
      billing_reason:'subscription_cycle',lines:{data:[{...a.invoice.lines.data[0]!,id:'il_addon_a_older',
        period:{start:Date.parse('2029-12-01')/1000,end:Date.parse('2030-01-01')/1000}}],has_more:false}}};
    seed.sources.push(older);
    vi.mocked(seed.stripe.invoices.list).mockImplementation(async params=>{
      if(params?.subscription===a.remote.id)return {data:[params.starting_after?older.invoice:a.invoice],has_more:!params.starting_after} as never;
      return {data:[seed.sources[1]!.invoice],has_more:false} as never;
    });
  });
  afterAll(async()=>{await db?.cleanup();vi.restoreAllMocks();vi.unstubAllEnvs();resetStripeClientCache();});
  it('runs the exact operator dry-run under a real read-only transaction with a named tuple',async()=>{
    const args=['--mode','live','--account','acct_Controls','--organisation','control-org','--dry-run'];
    const beforeRows=await db.prisma.billingAddonInvoiceRecovery.findMany({orderBy:{subscriptionId:'asc'}});
    const plan=await db.prisma.$transaction(async tx=>{
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return runAddonInvoiceRecoveryCommand(args,{prisma:tx as never});
    });
    expect(plan).toMatchObject({mode:'live',dry_run:true,inventory:{pending:2n,complete:0n,held:0n,missing:0n},invoices:0});
    expect(await db.prisma.billingAddonInvoiceRecovery.findMany({orderBy:{subscriptionId:'asc'}})).toEqual(beforeRows);
    await expect(runAddonInvoiceRecoveryCommand([...args,'--apply'],{prisma:db.prisma})).rejects.toThrow('EXACT_MODE_ACCOUNT_ORGANISATION_AND_OPERATION_REQUIRED');
    await expect(runAddonInvoiceRecoveryCommand(args.map(value=>value==='acct_Controls'?'acct_wrong':value),{prisma:db.prisma}))
      .rejects.toThrow('NAMED_STRIPE_ACCOUNT_REQUIRED');
  });
  it('keeps a transient read failure pending without advancing or creating financial objects',async()=>{
    const legacy=requireStripeWebhookConfigured().client;
    const legacyRead=vi.spyOn(legacy.accounts,'retrieveCurrent').mockRejectedValue(Error('EXPIRED LEGACY MUST NOT READ'));
    vi.mocked(client.invoices.list).mockRejectedValueOnce(Error('untrusted provider payload must not be persisted'));
    expect(await runAddonInvoiceRecoveryCycle({prisma:db.prisma,now:()=>at})).toEqual({checked:1,invoices:0,completed:0,held:1});
    const row=await db.prisma.billingAddonInvoiceRecovery.findFirstOrThrow({where:{holdReason:{not:null}}});
    expect(row).toMatchObject({cursor:null,complete:false,scanBefore:at,holdReason:'BILLING_ADDON_INVOICE_RECOVERY_UNAVAILABLE',leaseToken:null});
    expect(row.nextAttemptAt>at).toBe(true);expect(legacyRead).not.toHaveBeenCalled();
    expect(await db.prisma.billingStripePaymentInvoice.count()).toBe(0);
    await expect(assertAddonInvoiceHistoryComplete(db.prisma,'control-org',seed.account.id,true))
      .rejects.toThrow('BILLING_ADDON_HISTORY_RECONCILIATION_REQUIRED');
  });
  it('automatically retries and resumes a bounded cursor with original cash and no invented entitlement/base/receipt',async()=>{
    const result=await runAddonInvoiceRecoveryCommand(['--mode','live','--account','acct_Controls','--organisation','control-org',
      '--apply','--max-cycles','3'],{prisma:db.prisma,now:()=>later});
    expect(result).toMatchObject({checked:3,invoices:3,completed:2,held:0});
    await expect(assertAddonInvoiceHistoryComplete(db.prisma,'control-org',seed.account.id,true)).resolves.toBeUndefined();
    const a=await db.prisma.billingAddonInvoiceRecovery.findUniqueOrThrow({where:{subscriptionId:seed.sources[0]!.subscription.id}});
    expect(a).toMatchObject({scanBefore:at,cursor:'in_addon_a_older',complete:true,attemptCount:3,holdReason:null});
    expect(await runAddonInvoiceRecoveryCycle({prisma:db.prisma,now:()=>later})).toEqual({checked:0,invoices:0,completed:0,held:0});
    expect(await db.prisma.billingStripePaymentInvoice.count()).toBe(3);expect(await db.prisma.billingStripePaymentInvoiceCashPayment.count()).toBe(3);
    expect(await db.prisma.billingStripeSubscription.count()).toBe(0);expect(await db.prisma.billingCreditEntry.count()).toBe(0);
    expect(await db.prisma.billingCreditAutoTopUpConsentRevision.count()).toBe(1);
    expect(await db.prisma.billingStripeWebhookEvent.count()).toBe(3); // Original setup + two checkout receipts only.
    expect(await db.prisma.billingRecurringAddonSubscription.findMany({orderBy:{id:'asc'}})).toEqual(before);
    const list=await listCustomerInvoices(context(seed),{chargeMonth:'2030-01'},{prisma:db.prisma});expect(list.invoices).toHaveLength(3);
    await expect(db.prisma.billingAddonInvoiceRecovery.update({where:{subscriptionId:a.subscriptionId},data:{scanBefore:later}}))
      .rejects.toThrow('ADDON_INVOICE_RECOVERY_BINDING_IMMUTABLE');
    await expect(db.prisma.billingAddonInvoiceRecovery.delete({where:{subscriptionId:a.subscriptionId}}))
      .rejects.toThrow('ADDON_INVOICE_RECOVERY_RETAINED');
  });
});

describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS!=='true')('historical add-on adjustment completeness',()=>{
  let db:Db,seed:Seed;
  beforeAll(async()=>{
    const handle=await createTestDb();if(!handle)throw Error('Disposable PG required');db=handle;seed=await seedOrganisationAddonInvoices(db.prisma);configure();
    const retrieve=vi.mocked(seed.stripe.charges.retrieve).getMockImplementation()!;
    vi.mocked(seed.stripe.charges.retrieve).mockImplementation(async(...args)=>{
      const charge=await retrieve(...args);return {...charge,amount_refunded:args[0]==='ch_addon_b'?100:0} as never;
    });
  });
  afterAll(async()=>{await db?.cleanup();vi.restoreAllMocks();vi.unstubAllEnvs();resetStripeClientCache();});
  const runtime=async()=>({client:seed.stripe,livemode:true,webhookSecret:'fixture'});
  it('does not confirm an old refunded invoice until its original cash movement is actually proven',async()=>{
    expect(await runAddonInvoiceRecoveryCycle({prisma:db.prisma,now:()=>at,runtime})).toMatchObject({completed:1,held:0});
    expect(await runAddonInvoiceRecoveryCycle({prisma:db.prisma,now:()=>at,runtime})).toMatchObject({completed:0,held:1});
    expect(await db.prisma.billingStripePaymentInvoice.count()).toBe(1);
    await expect(listCustomerInvoices(context(seed),{chargeMonth:'2030-01'},{prisma:db.prisma}))
      .rejects.toThrow('BILLING_ADDON_HISTORY_RECONCILIATION_REQUIRED');
    const known=await db.prisma.billingStripePaymentInvoice.findFirstOrThrow();
    expect((await getCustomerInvoiceDetail(context(seed),`stripe:${known.id}`,{prisma:db.prisma})).totals.total_paid.amount_minor).toBe('5000');
    const refund={id:'re_addon_original',livemode:true,status:'succeeded',amount:100,currency:'usd',payment_intent:'pi_addon_b',charge:'ch_addon_b',
      balance_transaction:'bt_addon_original'};
    seed.stripe.refunds={retrieve:vi.fn().mockResolvedValue(refund)} as never;
    seed.stripe.balanceTransactions={retrieve:vi.fn().mockResolvedValue({id:refund.balance_transaction,source:refund.id,amount:-100,currency:'usd',
      exchange_rate:null,created:seed.paidAt.getTime()/1000+60})} as never;
    vi.mocked(seed.stripe.webhooks.constructEvent).mockReturnValue({id:'evt_addon_original_refund',type:'refund.updated',livemode:true,
      api_version:'2026-06-24.dahlia',account:seed.account.stripeAccountId,created:seed.paidAt.getTime()/1000+120,data:{object:refund}} as never);
    const params={rawBody:Buffer.from('{}'),signature:'synthetic-provider-boundary'},deps={prisma:db.prisma,stripe:seed.stripe,
      stripeLivemode:true,webhookSecret:'fixture',collectionEnabled:false};
    expect(await handleStripeWebhook(params,deps)).toEqual({duplicate:false});expect(await handleStripeWebhook(params,deps)).toEqual({duplicate:true});
    expect(await runAddonInvoiceRecoveryCycle({prisma:db.prisma,now:()=>later,runtime})).toMatchObject({completed:1,held:0});
    const list=await listCustomerInvoices(context(seed),{chargeMonth:'2030-01'},{prisma:db.prisma});expect(list.invoices).toHaveLength(2);
    const recovered=await db.prisma.billingStripePaymentInvoice.findFirstOrThrow({where:{stripeInvoiceId:'in_addon_b'}});
    expect(list.invoices.find(row=>row.invoice_id===`stripe:${recovered.id}`)).toMatchObject({status:'pending_document',
      totals:{total_paid:{amount_minor:'5000'},refunded_amount:{amount_minor:'100'}}});
    expect(await db.prisma.billingStripePaymentInvoiceAdjustment.count()).toBe(1);expect(await db.prisma.billingCreditEntry.count()).toBe(0);
  });
});
