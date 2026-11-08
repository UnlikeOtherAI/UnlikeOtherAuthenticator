import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { projectManualCustomerInvoiceSummary } from './billing-customer-invoice-manual.service.js';
import { assertInvoiceTaxTerms } from './billing-invoice-tax.service.js';
import { verifyOrganisationInvoiceServices } from './billing-organisation-history.service.js';
import type { OrganisationAccrualLine } from './billing-organisation-accrual-totals.service.js';

type Input={organisationId:string;accountId:string;period:{month:string;start:Date;end:Date;asOf:Date};observedAt:Date};
function hold(code:string):never{throw new AppError('INTERNAL',409,code);}
/** A contract has no durable tax agreement for an unissued month. Only actual
 * issued line allocations prove its final subscription, usage, tax and funding.
 * Older unbound contracts retain their evidence and require reconciliation. */
export async function readOrganisationAccruedManual(input:Input,db:PrismaClient) {
  const contracts=await db.billingOrganisationContract.findMany({where:{orgId:input.organisationId,
    activatedAt:{lt:input.period.asOf},OR:[{status:'ACTIVE'},{terminatedAt:{gt:input.period.start}}]},
    include:{versions:{where:{effectiveFromMonth:{lte:input.period.month}},orderBy:[{effectiveFromMonth:'desc'},{version:'desc'}],
      take:1,include:{serviceTerms:{include:{service:true}}}}}});
  if(contracts.some(row=>row.billingAccountId===null))hold('BILLING_ACCRUAL_MANUAL_BINDING_RECONCILIATION_REQUIRED');
  const lines:OrganisationAccrualLine[]=[],paid=new Map<string,bigint>(),coveredProducts=new Set<string>(),currencies=new Set<string>();
  for(const contract of contracts.filter(row=>row.billingAccountId===input.accountId)){
    const version=contract.versions[0];if(!version?.serviceTerms.length)hold('BILLING_ACCRUAL_MANUAL_TERMS_RECONCILIATION_REQUIRED');
    const invoices=await db.billingInvoice.findMany({where:{orgId:input.organisationId,contractId:contract.id,
      billingMonth:input.period.month,status:{in:['ISSUED','VOID']},issuedAt:{lte:input.observedAt}},
      include:{lines:true,lineFinancialAllocations:true,paymentEvents:true,manualCreditNotes:true}});
    if(!invoices.length)hold('BILLING_ACCRUAL_MANUAL_TAX_RECONCILIATION_REQUIRED');
    const covered=new Set<string>();
    for(const row of invoices){
      const summary=projectManualCustomerInvoiceSummary(row);
      currencies.add(row.currency);
      await verifyOrganisationInvoiceServices(db,row.lines);
      if(row.contractVersionId!==version.id||!row.taxTreatment||row.taxRateBps===null||!row.taxLegalBasis)
        hold('BILLING_ACCRUAL_MANUAL_TERMS_RECONCILIATION_REQUIRED');
      assertInvoiceTaxTerms({treatment:row.taxTreatment as 'NO_TAX_CHARGED'|'STANDARD_RATE',rateBps:row.taxRateBps,legalBasis:row.taxLegalBasis});
      const cash=row.paymentEvents.filter(event=>event.occurredAt<=input.observedAt);
      if(cash.some(event=>event.kind!=='PAYMENT')||row.manualCreditNotes.some(note=>note.status==='ISSUED')||summary.status==='voided')
        hold('BILLING_ACCRUAL_MANUAL_PAYMENT_RECONCILIATION_REQUIRED');
      if(row.lineFinancialAllocations.length!==row.lines.length||
        row.lineFinancialAllocations.reduce((sum,line)=>sum+line.taxMinor,0n)!==row.taxAmountMinor||
        row.lineFinancialAllocations.reduce((sum,line)=>sum+line.invoiceCreditMinor,0n)!==row.creditsAppliedMinor)
        hold('BILLING_ACCRUAL_MANUAL_ALLOCATION_RECONCILIATION_REQUIRED');
      for(const line of row.lines){
        const allocation=row.lineFinancialAllocations.find(value=>value.lineId===line.id);
        if(!allocation||covered.has(line.serviceId)||coveredProducts.has(line.serviceIdentifier)||
          !version.serviceTerms.some(term=>term.serviceId===line.serviceId)||allocation.serviceId!==line.serviceId||
          allocation.billingMonth!==input.period.month||allocation.currency!==row.currency||line.currency!==row.currency||
          allocation.calculationDigest!==row.calculationDigest||allocation.subscriptionMinor<0n||allocation.usageMinor<0n||
          allocation.taxMinor<0n||allocation.invoiceCreditMinor<0n||allocation.invoiceCreditMinor>allocation.usageMinor||
          allocation.subscriptionMinor+allocation.usageMinor!==line.amountMinor||
          allocation.totalMinor!==line.amountMinor+allocation.taxMinor||allocation.dueMinor!==allocation.totalMinor-allocation.invoiceCreditMinor)
          hold('BILLING_ACCRUAL_MANUAL_ALLOCATION_RECONCILIATION_REQUIRED');
        covered.add(line.serviceId);coveredProducts.add(line.serviceIdentifier);
        const add=(kind:OrganisationAccrualLine['kind'],amountMinor:bigint)=>{
          if(amountMinor!==0n)lines.push({id:`manual:${row.id}:${line.id}:${kind}`,kind,amountMinor,
            product:line.serviceIdentifier,label:line.serviceName,currency:row.currency});};
        add('subscription',allocation.subscriptionMinor);add('usage',allocation.usageMinor);
        add('tax',allocation.taxMinor);add('prepaid_credit',-allocation.invoiceCreditMinor);
      }
      paid.set(row.currency,(paid.get(row.currency)??0n)+cash.reduce((sum,event)=>sum+event.amountMinor,0n));
    }
    if(version.serviceTerms.some(term=>!covered.has(term.serviceId)))hold('BILLING_ACCRUAL_MANUAL_ALLOCATION_RECONCILIATION_REQUIRED');
  }
  return {lines,paid,coveredProducts,currencies};
}
