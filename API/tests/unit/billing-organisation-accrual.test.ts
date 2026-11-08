import { beforeEach,describe,expect,it,vi } from 'vitest';
import { organisationAccrualTotals,type OrganisationAccrualLine } from '../../src/services/billing-organisation-accrual-totals.service.js';
import { readOrganisationAccruedAdjustments } from '../../src/services/billing-organisation-accrual-adjustment.service.js';
import { readVerifiedCycleCreditEvidence } from '../../src/services/billing-cycle-paid-credit-evidence.service.js';
const receipt=vi.hoisted(()=>({rawCostTotal:'1.000000000000000000',ratedMicrocredits:1300000000n,receiptCount:1,legacyMicrocredits:0n}));
vi.mock('../../src/services/billing-ledger-paid-receipt-proof.service.js',()=>({matchUoaPaidReceiptSet:async()=>receipt}));
const line=(kind:OrganisationAccrualLine['kind'],amountMinor:bigint,currency:string):OrganisationAccrualLine=>({
  id:`${kind}:${currency}`,product:'nessie',label:'Nessie',kind,amountMinor,currency});
describe('organisation accrual source arithmetic',()=>{
  it('separates USD prepaid usage, EUR subscription/tax and GBP adjustments without a local FX conversion',()=>{
    const result=organisationAccrualTotals([line('usage',130n,'USD'),line('prepaid_credit',-100n,'USD'),
      line('subscription',299n,'EUR'),line('tax',60n,'EUR'),line('subscription',399n,'GBP'),line('adjustment',-99n,'GBP')],
      new Map([['EUR',100n],['GBP',100n]]),[]);
    expect(result.totals).toMatchObject([
      {currency:'EUR',gross_total:{amount_minor:'359'},total_paid:{amount_minor:'100'},outstanding:{amount_minor:'259'}},
      {currency:'GBP',gross_total:{amount_minor:'300'},total_paid:{amount_minor:'100'},outstanding:{amount_minor:'200'}},
      {currency:'USD',gross_total:{amount_minor:'130'},credits_applied:{amount_minor:'100'},total_due:{amount_minor:'30'}}]);
    expect(result.lines[1]?.amount).toMatchObject({amount:'-1',display:'-$1.00',currency:'USD'});
    expect(result.lines[2]?.amount.display).toBe('€2.99');
    expect(organisationAccrualTotals([],new Map(),['EUR']).totals.map(row=>row.currency)).toEqual(['EUR']);
    expect(()=>organisationAccrualTotals([line('usage',1n,'USD')],new Map([['USD',2n]]),[]))
      .toThrow('BILLING_ACCRUAL_FINANCIAL_RECONCILIATION_REQUIRED');
  });
  it('counts org and team-targeted adjustments once, excludes another captured account and holds absent binding/tax evidence',async()=>{
    const rows=[{id:'org-fee',scope:'ORGANISATION',teamId:null,billingAccountId:'live',service:{identifier:'nessie'},
      amountMinor:100n,name:'Org fee',kind:'ADD_ON',currency:'EUR',active:true},
      {id:'team-credit',scope:'TEAM',teamId:'other-team',billingAccountId:'live',service:{identifier:'nessie'},
        amountMinor:30n,name:'Credit',kind:'CREDIT',currency:'EUR',active:true},
      {id:'test-fee',billingAccountId:'test',service:{identifier:'nessie'},amountMinor:900n,currency:'EUR',active:true}];
    const db={billingCommercialAdjustment:{findMany:vi.fn().mockResolvedValue(rows)}};
    const input={organisationId:'org',accountId:'live',period:{start:new Date('2028-02-01'),asOf:new Date('2028-02-08')},noTaxProducts:new Set(['nessie'])};
    const result=await readOrganisationAccruedAdjustments(input,db as never);
    expect(result.map(row=>row.amountMinor)).toEqual([100n,-30n]);
    expect(db.billingCommercialAdjustment.findMany.mock.calls[0]?.[0].where).not.toHaveProperty('teamId');
    await expect(readOrganisationAccruedAdjustments({...input,noTaxProducts:new Set()},db as never))
      .rejects.toThrow('BILLING_ACCRUAL_ADJUSTMENT_TAX_RECONCILIATION_REQUIRED');
    rows[0]!.billingAccountId=null as never;
    await expect(readOrganisationAccruedAdjustments(input,db as never)).rejects.toThrow('BILLING_ACCRUAL_ADJUSTMENT_BINDING_RECONCILIATION_REQUIRED');
  });
});
describe('USD receipt money beside a different subscription currency',()=>{
  let db:ReturnType<typeof database>;
  function database(){return {$queryRaw:vi.fn().mockResolvedValue([{unknown:false,different:false}]),
    billingPaidUsageLiability:{findMany:vi.fn().mockResolvedValue([{dispatchId:'dispatch',receiptId:'receipt',tariffId:'tariff',currency:'USD',
      paymentMode:'PAY_AS_YOU_GO',creditAccountId:null,ratedMicrocredits:1300000000n}])},
    billingCreditBudgetLegacyLiability:{findMany:vi.fn().mockResolvedValue([])},billingPaidUsageException:{findMany:vi.fn().mockResolvedValue([])},
    billingCreditUsageSettlement:{findMany:vi.fn().mockResolvedValue([])}};}
  beforeEach(()=>{db=database();});
  const input={scope:{product:'nessie',organisationId:'org',teamId:'team',billingMonth:'2028-02',serviceId:'service'},
    proof:{scope:{billing_product:'nessie',organization_id:'org',team_id:'team',billing_month:'2028-02'},unresolved_paid_attempts:'0',
      snapshot:{immutable:true},paid_receipt_count:'1',paid_receipt_sha256:'a'.repeat(64)},payer:'ORGANISATION',
    tariff:{id:'tariff',currency:'EUR',usagePaymentMode:'PAY_AS_YOU_GO'},rawLines:[{billingDisposition:'paid',selectedProviderCost:'1',currency:'USD'}],
    accountId:'live',allowUnsettled:true,organisationSettlementCurrency:'USD'};
  it('uses frozen USD liability and exact captured account without converting a EUR monthly price',async()=>{
    db.billingCreditUsageSettlement.findMany.mockResolvedValue([{id:'settlement',creditAccount:{orgId:'org',teamId:null,scope:'ORGANISATION',accountId:'live'},
      tariffId:'tariff',currency:'USD',status:'APPLIED',cumulativeCreditsConsumedMicrocredits:1300000000n,
      adjustments:[{id:'adjustment',cumulativeCreditsConsumedMicrocredits:1300000000n}]}] as never);
    expect(await readVerifiedCycleCreditEvidence(db as never,input as never)).toMatchObject({consumed_microcredits:'1300000000',funded_debit_microcredits:'1300000000'});
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    await expect(readVerifiedCycleCreditEvidence(db as never,{...input,organisationSettlementCurrency:undefined} as never))
      .rejects.toThrow('BILLING_CYCLE_FX_RECONCILIATION_REQUIRED');
  });
  it('refuses non-USD raw cost/liability and a TEAM payer despite a claimed USD organisation representation',async()=>{
    await expect(readVerifiedCycleCreditEvidence(db as never,input as never)).rejects.toThrow('BILLING_CYCLE_FX_RECONCILIATION_REQUIRED');
    await expect(readVerifiedCycleCreditEvidence(db as never,{...input,payer:'TEAM'} as never)).rejects.toThrow('BILLING_CYCLE_FX_RECONCILIATION_REQUIRED');
    await expect(readVerifiedCycleCreditEvidence(db as never,{...input,rawLines:[{billingDisposition:'paid',selectedProviderCost:'1',currency:'EUR'}]} as never))
      .rejects.toThrow('BILLING_CYCLE_PAID_COST_MISSING');
    db.billingPaidUsageLiability.findMany.mockResolvedValue([{...input,currency:'EUR'}] as never);
    await expect(readVerifiedCycleCreditEvidence(db as never,input as never)).rejects.toThrow('BILLING_CYCLE_PAID_LIABILITY_TERMS_CONFLICT');
  });
});
