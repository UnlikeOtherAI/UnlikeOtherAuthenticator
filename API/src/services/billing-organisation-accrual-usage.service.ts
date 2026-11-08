import { BillingAssignmentScope,type PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { fetchLedgerHistoricalBillingTeams } from './billing-ledger-team-discovery.service.js';
import { fetchLedgerMeteringUsage } from './billing-ledger-collector.service.js';
import { fetchVerifiedLedgerPaidReceiptSet } from './billing-ledger-paid-receipt-proof.service.js';
import { readVerifiedCycleCreditEvidence,usdFromRatedMicrocredits } from './billing-cycle-paid-credit-evidence.service.js';
import { projectCycleUsage } from './billing-cycle-usage-projection.service.js';
import { resolveBillingTariffForMonth } from './billing-tariff-history.service.js';
import { majorAmountToMinorRounded } from './billing-money.service.js';
import type { OrganisationAccrualLine } from './billing-organisation-accrual-totals.service.js';

const products=['nessie','deepwater','deepsignal','deeptest','docgen','salesnerd'];
type Period={month:string;start:Date;end:Date;asOf:Date};
export async function readOrganisationAccruedUsage(input:{organisationId:string;accountId:string;period:Period},
  prisma:PrismaClient,deps:{discover?:typeof fetchLedgerHistoricalBillingTeams;fetch?:typeof fetchLedgerMeteringUsage;
    proof?:typeof fetchVerifiedLedgerPaidReceiptSet}={}):Promise<OrganisationAccrualLine[]> {
  const services=await prisma.billingService.findMany({where:{identifier:{in:products}},orderBy:{identifier:'asc'}});
  const unsupported=await prisma.billingPaidUsageLiability.count({where:{orgId:input.organisationId,
    billingMonth:input.period.month,serviceId:{notIn:services.map(service=>service.id)}}});
  if(unsupported)throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_PRODUCT_UNSUPPORTED');
  const lines:OrganisationAccrualLine[]=[];
  for(const service of services){
    const discovery=await (deps.discover??fetchLedgerHistoricalBillingTeams)({product:service.identifier,
      organisationId:input.organisationId,billingMonth:input.period.month});
    let gross=0n;let funded=0n;
    // Serial bounded requests: the independent wallet/controls never call this reader.
    for(const teamId of discovery.teamIds){
      const scope={product:service.identifier,organisationId:input.organisationId,teamId,
        billingMonth:input.period.month,serviceId:service.id};
      const [usage,proof,effective]=await Promise.all([
        (deps.fetch??fetchLedgerMeteringUsage)({...scope,groupBy:'user'}),
        (deps.proof??fetchVerifiedLedgerPaidReceiptSet)(scope),
        resolveBillingTariffForMonth(prisma,{...scope}),
      ]);
      const projected=projectCycleUsage(usage,{serviceIdentifier:service.identifier,organisationId:input.organisationId,
        teamId,billingMonth:input.period.month,startsAt:input.period.start,endsAt:input.period.end,currency:'USD'},effective.tariff);
      const evidence=await readVerifiedCycleCreditEvidence(prisma,{scope,proof,payer:BillingAssignmentScope.ORGANISATION,
        tariff:effective.tariff,rawLines:projected.evidence.raw_lines,accountId:input.accountId,allowUnsettled:true});
      if(evidence.funded_debit_microcredits===null)throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_CREDIT_RECONCILIATION_REQUIRED');
      gross+=BigInt(evidence.consumed_microcredits)-BigInt(evidence.waived_microcredits);
      funded+=BigInt(evidence.funded_debit_microcredits);
    }
    if(funded>gross)throw new AppError('INTERNAL',409,'BILLING_ACCRUAL_CREDIT_RECONCILIATION_REQUIRED');
    const amount=majorAmountToMinorRounded(usdFromRatedMicrocredits(gross),'USD');
    const offset=majorAmountToMinorRounded(usdFromRatedMicrocredits(funded),'USD');
    if(gross>0n)lines.push({id:`usage:${service.id}`,product:service.identifier,label:service.name,
      kind:'usage',currency:'USD',amountMinor:amount});
    if(funded>0n)lines.push({id:`credits:${service.id}`,product:service.identifier,label:service.name,
      kind:'prepaid_credit',currency:'USD',amountMinor:-offset});
  }
  return lines;
}
