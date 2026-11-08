import type { BillingCreditBudgetDispatch,Prisma } from '@prisma/client';
import { AppError } from '../utils/errors.js';

/** Reconcile the captured reservation belonging to this runtime. Telecom has
 * separate reservation records; it must never borrow an LLM reservation. */
export async function assertCapturedPrepaidSource(tx:Prisma.TransactionClient,
  hold:BillingCreditBudgetDispatch,creditAccountId:string,receiptId:string) {
  const wallet=await tx.billingCreditAccount.findUnique({where:{id:creditAccountId},select:{accountId:true,orgId:true}});
  let source:{creditAccountId:string;orgId:string;teamId:string;userId:string;serviceId:string}|null=null;
  if(hold.providerServiceId==='twilio-voice') {
    const row=await tx.billingVoiceReservation.findUnique({where:{dispatchId:hold.dispatchId}});
    if(row&&hold.tariffId===`voice-quote:${row.quoteId}`&&(!row.callSid||row.callSid===receiptId))source=row;
  } else if(hold.providerServiceId==='twilio-sms'&&hold.dispatchId.startsWith('sms-inbound:')) {
    const accountSid=/^sms-inbound:(AC[0-9a-fA-F]{32}):/.exec(hold.dispatchId)?.[1];
    const row=accountSid?await tx.billingSmsInboundReceipt.findUnique({where:{accountSid_messageSid:{accountSid,messageSid:receiptId}}}):null;
    const standing=row?.standingHoldId?await tx.billingSmsStandingHold.findUnique({where:{id:row.standingHoldId}}):null;
    if(row&&standing&&row.messageSid===receiptId&&hold.dispatchId===`sms-inbound:${row.accountSid}:${receiptId}`&&
      row.orgId===standing.orgId&&row.teamId===standing.teamId&&row.serviceId===standing.serviceId&&
      row.numberId===standing.numberId&&row.allocationId===standing.allocationId) {
      source={...standing,userId:standing.requestedByUserId};
    }
  } else if(hold.providerServiceId==='twilio-sms') {
    const row=await tx.billingSmsReservation.findUnique({where:{dispatchId:hold.dispatchId}});
    if(row&&hold.tariffId===`sms-quote:${row.quoteId}`&&(!row.messageSid||row.messageSid===receiptId))source=row;
  } else {
    source=await tx.billingPrepaidReservation.findUnique({where:{dispatchId:hold.dispatchId},
      select:{creditAccountId:true,orgId:true,teamId:true,userId:true,serviceId:true}});
  }
  if(!wallet||wallet.orgId!==hold.orgId||source?.creditAccountId!==creditAccountId||source.orgId!==hold.orgId||
    source.teamId!==hold.teamId||source.userId!==hold.userId||source.serviceId!==hold.serviceId||
    (hold.billingAccountId&&wallet.accountId!==hold.billingAccountId)) {
    throw new AppError('BAD_REQUEST',409,'BILLING_CAPTURED_ACCOUNT_MISMATCH');
  }
}
