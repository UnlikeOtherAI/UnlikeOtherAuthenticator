import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as ajvFormats from 'ajv-formats';
import { createTestDb } from '../helpers/test-db.js';
import { captureOrganisationFinancialSource } from '../../src/services/billing-financial-source-binding.service.js';
import { issueBillingInvoice } from '../../src/services/billing-invoice-lifecycle.service.js';
import { readOrganisationAccruedBill } from '../../src/services/billing-organisation-accrual.service.js';
import { resolveOrganisationBillingMode } from '../../src/services/billing-organisation-mode.service.js';
import { calculateBillingContractInvoice } from '../../src/services/billing-invoice-calculation.service.js';
import { listCustomerInvoices,getCustomerInvoiceDetail,downloadCustomerInvoice } from '../../src/services/billing-customer-invoice-read.service.js';
import { billingCycleSnapshotDigest,listBillingCycles } from '../../src/services/billing-cycle-read.service.js';
import type { BillingCycleContext } from '../../src/services/billing-cycle-read.service.js';
import { billingCycleDetailV2ConformanceFixture,billingOrganisationFinancialV1Schemas } from '../../src/contracts/billing-statement-v1.js';
import type { BillingInvoicePdfStorage } from '../../src/services/billing-invoice-storage.service.js';

vi.mock('../../src/services/billing-actor.service.js',()=>({verifyBillingActor:vi.fn().mockResolvedValue({})}));
const validator=new Ajv2020({strict:true,allErrors:true});ajvFormats.default.default(validator);
const validateList=validator.compile(billingOrganisationFinancialV1Schemas.invoices_list_response);
const validateDetail=validator.compile(billingOrganisationFinancialV1Schemas.invoice_detail_response);
describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS!=='true')('captured organisation manual financial history',()=>{
  let handle:NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let invoiceId:string,termId:string;const objects=new Map<string,Buffer>();
  const storage:BillingInvoicePdfStorage={putImmutable:async(key,bytes)=>{if(objects.has(key))throw Error('IMMUTABLE');objects.set(key,Buffer.from(bytes));},
    read:async key=>{const bytes=objects.get(key);if(!bytes)throw Error('MISSING');return bytes;}};
  const context:BillingCycleContext={credential:{service:{id:'manual-service',identifier:'manual',name:'Manual'}} as BillingCycleContext['credential'],
    actorToken:'verified',endpoint:'/billing/v1/invoices/list',financialScope:'organisation',billingMode:'live',
    request:{organisationId:'manual-org',teamId:null,userId:'manual-owner',product:'manual'}};
  beforeAll(async()=>{
    const db=await createTestDb();if(!db)throw Error('Disposable PG required');handle=db;const p=db.prisma;
    for(const mode of ['LIVE','SANDBOX']){
      vi.stubEnv(`STRIPE_${mode}_ACCOUNT_ID`,'acct_ManualHistory');vi.stubEnv(`STRIPE_${mode}_SECRET_KEY`,mode==='LIVE'?'rk_live_fixture':'rk_test_fixture');
      vi.stubEnv(`STRIPE_${mode}_WEBHOOK_SECRET`,'whsec_fixture_'+mode);
    }
    await p.user.create({data:{id:'manual-owner',email:'manual@example.test',userKey:'manual@example.test'}});
    await p.organisation.create({data:{id:'manual-org',name:'Manual',slug:'manual',domain:'manual.example.test',ownerId:'manual-owner'}});
    await p.orgMember.create({data:{orgId:'manual-org',userId:'manual-owner',role:'owner'}});
    await p.team.create({data:{id:'manual-team',orgId:'manual-org',name:'Selected',slug:'selected'}});
    await p.billingStripeAccount.createMany({data:[{id:'manual-live',stripeAccountId:'acct_ManualHistory',livemode:true},
      {id:'manual-test',stripeAccountId:'acct_ManualHistory',livemode:false}]});
    await p.billingService.createMany({data:[{id:'manual-service',identifier:'manual',name:'Manual'},
      {id:'other-service',identifier:'other',name:'Other'}]});
    for(const serviceId of ['manual-service','other-service'])await p.billingTariff.create({data:{id:serviceId+'-tariff',serviceId,key:'manual',version:1,
      name:'Manual',mode:'CUSTOM',collectionMode:'MANUAL',markupBps:3000,currency:'USD',monthlyAmountMinor:1000n}});
    const contract=await p.$transaction(async tx=>tx.billingOrganisationContract.create({data:{
      ...await captureOrganisationFinancialSource(tx,'manual-org'),orgId:'manual-org',reference:'history',name:'History',
      status:'ACTIVE',activatedAt:new Date('2030-01-01T00:00:00Z')}}));
    const version=await p.billingOrganisationContractVersion.create({data:{contractId:contract.id,version:1,usageMarkupBps:3000,
      currency:'USD',paymentTermsDays:30,effectiveFromMonth:'2030-01'}});
    for(const serviceId of ['manual-service','other-service']){
      const term=await p.billingContractServiceTerm.create({data:{contractVersionId:version.id,serviceId,
        tariffId:serviceId+'-tariff',monthlyAmountMinor:1000n}});if(serviceId==='manual-service')termId=term.id;
    }
    const issuer=await p.billingInvoiceIssuerProfile.create({data:{key:'manual',legalName:'Issuer Ltd',billingEmail:'billing@example.test',
      address:{country:'GB',line1:'One'},invoiceNumberPrefix:'HIST'}});
    const buyer=await p.billingOrganisationInvoiceProfile.create({data:{orgId:'manual-org',legalName:'Buyer Ltd',
      billingEmail:'buyer@example.test',billingAddress:{country:'GB',line1:'Two'}}});
    const invoice=await p.billingInvoice.create({data:{orgId:'manual-org',contractId:contract.id,contractVersionId:version.id,
      issuerProfileId:issuer.id,buyerProfileId:buyer.id,billingMonth:'2030-01',currency:'USD',subtotalMinor:2000n,totalMinor:2000n,
      taxTreatment:'NO_TAX_CHARGED',taxRateBps:0,taxLegalBasis:'Outside scope',calculationDigest:'a'.repeat(64),
      issuerSnapshot:{legal_name:'Issuer Ltd',billing_email:issuer.billingEmail,address:issuer.address},
      buyerSnapshot:{legal_name:'Buyer Ltd',billing_email:buyer.billingEmail,billing_address:buyer.billingAddress},
      lines:{create:['manual-service','other-service'].map((serviceId,index)=>({serviceId,serviceIdentifier:index?'other':'manual',
        serviceName:index?'Other':'Manual',amountMinor:1000n,currency:'USD',position:index}))},
      meteringRefs:{create:['manual-service','other-service'].map(serviceId=>({serviceId,ledgerSnapshotCursor:'empty',
        ledgerSnapshotSha256:'b'.repeat(64),capturedAt:new Date('2030-02-01T00:00:00Z')}))}}});
    invoiceId=invoice.id;
    const lines=await p.billingInvoiceLine.findMany({where:{invoiceId}});
    await p.billingInvoiceLineFinancialAllocation.createMany({data:lines.map(line=>({
      lineId:line.id,invoiceId,serviceId:line.serviceId,billingMonth:'2030-01',subscriptionMinor:1000n,usageMinor:0n,taxMinor:0n,
      invoiceCreditMinor:0n,totalMinor:1000n,dueMinor:1000n,currency:'USD',calculationDigest:'a'.repeat(64)}))});
    await issueBillingInvoice({invoiceId,actor:{email:'operator@example.test'}},{prisma:p,storage,now:()=>new Date('2030-02-01T00:00:00Z'),
      authorizeAdminEffect:vi.fn().mockResolvedValue(undefined)});
  });
  afterAll(async()=>{await handle?.cleanup();vi.unstubAllEnvs();});
  it('reads every registered product under the captured account and verifies the original PDF',async()=>{
    const p=handle.prisma,list=await listCustomerInvoices(context,{chargeMonth:'2030-02'},{prisma:p});
    expect(validateList(list),JSON.stringify(validateList.errors)).toBe(true);
    expect(list.invoices).toHaveLength(1);expect(list.invoices[0]?.product_identifiers).toEqual(['manual','other']);
    const detail=await getCustomerInvoiceDetail(context,`manual:${invoiceId}`,{prisma:p});
    expect(validateDetail(detail),JSON.stringify(validateDetail.errors)).toBe(true);
    expect(detail.charges).toHaveLength(2);expect(detail.document.download_action.body).toMatchObject({team_id:null,financial_scope:'organisation'});
    const download=await downloadCustomerInvoice(context,`manual:${invoiceId}`,`manual:${invoiceId}`,{prisma:p,storage});
    expect(download.bytes.subarray(0,5).toString()).toBe('%PDF-');
    await expect(getCustomerInvoiceDetail({...context,billingMode:'sandbox'},`manual:${invoiceId}`,{prisma:p})).rejects.toMatchObject({statusCode:404});
    expect((await listCustomerInvoices({...context,billingMode:'sandbox'},{chargeMonth:'2030-02'},{prisma:p})).invoices).toEqual([]);
  });
  it('binds invoice cursors to month and manual cycle sources to the captured contract',async()=>{
    const p=handle.prisma;
    // A later cash payment is a separate charge-month appearance, not another document.
    await p.billingInvoicePaymentEvent.create({data:{invoiceId,kind:'PAYMENT',source:'MANUAL',amountMinor:100n,currency:'USD',
      idempotencyKey:'cash',occurredAt:new Date('2030-03-01T00:00:00Z')}});
    const {historyCursorBinding,encodeOrganisationHistoryCursor}=await import('../../src/services/billing-organisation-history.service.js');
    const cursor=encodeOrganisationHistoryCursor({binding:historyCursorBinding(context,'manual-live','invoices:2030-02'),
      at:'2030-02-01T00:00:00.000Z',kind:'manual',id:invoiceId});
    await expect(listCustomerInvoices(context,{chargeMonth:'2030-03',cursor},{prisma:p})).rejects.toMatchObject({statusCode:400});
    const snapshot={...billingCycleDetailV2ConformanceFixture,cycle_id:'manual-cycle',state:'pending_reconciliation',
      period:{month:'2030-01',starts_at:'2030-01-01T00:00:00.000Z',ends_at:'2030-02-01T00:00:00.000Z'},
      scope:{organisation_id:'manual-org',team_id:null,cycle_scope:'organisation',payer_scope:'organisation'},
      product:{id:'manual-service',identifier:'manual',name:'Manual'},totals:[],subscription_lines:[],usage_lines:[],
      documents:[],document_available:false,adjustments:[],credits:{consumed:null,opening_balance:null,closing_balance:null,status:'pending_reconciliation'}};
    const evidence={quote:{source:{kind:'manual',id:termId}}};
    await p.billingCustomerCycle.create({data:{id:'manual-cycle',orgId:'manual-org',serviceId:'manual-service',billingMonth:'2030-01',
      revision:1,state:'pending_reconciliation',payerScope:'ORGANISATION',publicSnapshot:snapshot,privateEvidence:evidence,
      snapshotSha256:billingCycleSnapshotDigest(snapshot,evidence)}});
    expect((await listBillingCycles(context,{},{prisma:p})).cycles.map(row=>row.cycle_id)).toEqual(['manual-cycle']);
    expect((await listBillingCycles({...context,billingMode:'sandbox'},{},{prisma:p})).cycles).toEqual([]);
    const legacy={...context,financialScope:undefined,billingMode:undefined,request:{...context.request,teamId:'manual-team'}};
    const legacyList=await listBillingCycles(legacy,{},{prisma:p});
    expect(legacyList.cycles.map(row=>row.cycle_id)).toEqual(['manual-cycle']);
    expect(legacyList.subject).toEqual({product:'manual',organisation_id:'manual-org',team_id:'manual-team',user_id:'manual-owner'});
    expect(await p.billingCreditEntry.count()).toBe(0);
  });
  it('confirms the issued ORG bill from actual allocations and later cash, without counting a product twice',async()=>{
    const p=handle.prisma,selection=await resolveOrganisationBillingMode('manual-org',p);
    const bill=await readOrganisationAccruedBill(context,selection,'2030-01',new Date('2030-03-05T12:00:00Z'),p);
    expect(bill.as_of).toBe('2030-03-05T12:00:00.000Z');
    expect(bill.totals).toMatchObject([{currency:'USD',subscription:{amount_minor:'2000'},total_due:{amount_minor:'2000'},
      total_paid:{amount_minor:'100'},outstanding:{amount_minor:'1900'}}]);
    expect(bill.lines.filter(line=>line.kind==='subscription')).toHaveLength(2);
    await expect(readOrganisationAccruedBill(context,selection,'2030-02',new Date('2030-03-05T12:00:00Z'),p))
      .rejects.toThrow('BILLING_ACCRUAL_MANUAL_TAX_RECONCILIATION_REQUIRED');
    expect(await p.billingCreditEntry.count()).toBe(0);
  });
  it('calculates a new manual draft using the contract captured account without rebinding existing issued evidence',async()=>{
    const p=handle.prisma,original=await p.billingInvoice.findUniqueOrThrow({where:{id:invoiceId}});
    const invoice=await calculateBillingContractInvoice({contractId:original.contractId,issuerProfileId:original.issuerProfileId,
      billingMonth:'2030-01',taxTerms:{treatment:'NO_TAX_CHARGED',rateBps:0,legalBasis:'Outside tax scope'},
      actor:{email:'operator@example.test'}},{prisma:p,now:()=>new Date('2030-02-01T00:00:00Z'),
      fetchMetering:async input=>({schemaVersion:1,product:input.product,groupBy:'service',scope:{organizationId:'manual-org',teamId:null,
        userId:null,month:'2030-01',startsAt:'2030-01-01T00:00:00.000Z',endsAt:'2030-02-01T00:00:00.000Z'},calls:'0',lines:[],
        billingCompleteness:{state:'complete',unresolvedPaidAttempts:'0'},snapshot:{id:'empty',cursor:'empty',capturedAt:'2030-02-01T00:00:00Z',
          immutable:true,sha256:'c'.repeat(64)}})});
    expect(invoice).toMatchObject({status:'DRAFT',subtotalMinor:2000n,creditsAppliedMinor:0n});
    expect(await p.billingInvoice.findUniqueOrThrow({where:{id:invoiceId}})).toEqual(original);
    expect(await p.billingCreditEntry.count()).toBe(0);
  });
});
