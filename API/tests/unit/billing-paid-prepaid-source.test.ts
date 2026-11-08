import type { BillingCreditBudgetDispatch } from '@prisma/client';
import { describe,expect,it,vi } from 'vitest';
import { assertCapturedPrepaidSource } from '../../src/services/billing-paid-prepaid-source.service.js';

const common={creditAccountId:'wallet',orgId:'org',teamId:'team',userId:'human',serviceId:'service'};
const hold={dispatchId:'dispatch',orgId:'org',teamId:'team',userId:'human',serviceId:'service',
  billingAccountId:'captured-test',providerServiceId:'twilio-voice',tariffId:'voice-quote:quote'} as BillingCreditBudgetDispatch;
function fixture(){
  return {billingCreditAccount:{findUnique:vi.fn().mockResolvedValue({accountId:'captured-test',orgId:'org'})},
    billingVoiceReservation:{findUnique:vi.fn().mockResolvedValue({...common,quoteId:'quote',callSid:'receipt'})},
    billingSmsReservation:{findUnique:vi.fn().mockResolvedValue({...common,quoteId:'quote',messageSid:'receipt'})},
    billingPrepaidReservation:{findUnique:vi.fn().mockResolvedValue(common)},
    billingSmsInboundReceipt:{findUnique:vi.fn()},billingSmsStandingHold:{findUnique:vi.fn()}};
}
describe('captured prepaid runtime source',()=>{
  it('uses Voice evidence exclusively and refuses an opposing provider account',async()=>{
    const tx=fixture();await assertCapturedPrepaidSource(tx as never,hold,'wallet','receipt');
    expect(tx.billingPrepaidReservation.findUnique).not.toHaveBeenCalled();
    tx.billingCreditAccount.findUnique.mockResolvedValue({accountId:'live-account',orgId:'org'});
    await expect(assertCapturedPrepaidSource(tx as never,hold,'wallet','receipt')).rejects.toThrow('BILLING_CAPTURED_ACCOUNT_MISMATCH');
  });
  it.each(['teamId','userId','serviceId','orgId','creditAccountId'] as const)('refuses changed Voice %s evidence',async field=>{
    const tx=fixture();tx.billingVoiceReservation.findUnique.mockResolvedValue({...common,quoteId:'quote',callSid:'receipt',[field]:'foreign'});
    await expect(assertCapturedPrepaidSource(tx as never,hold,'wallet','receipt')).rejects.toThrow('BILLING_CAPTURED_ACCOUNT_MISMATCH');
  });
  it('cannot replace missing Voice evidence with a matching LLM reservation',async()=>{
    const tx=fixture();tx.billingVoiceReservation.findUnique.mockResolvedValue(null);
    await expect(assertCapturedPrepaidSource(tx as never,hold,'wallet','receipt')).rejects.toThrow('BILLING_CAPTURED_ACCOUNT_MISMATCH');
    expect(tx.billingPrepaidReservation.findUnique).not.toHaveBeenCalled();
  });
  it('binds outgoing SMS to its quote and exact receipt',async()=>{
    const tx=fixture(),sms={...hold,providerServiceId:'twilio-sms',tariffId:'sms-quote:quote'};
    await assertCapturedPrepaidSource(tx as never,sms,'wallet','receipt');
    await expect(assertCapturedPrepaidSource(tx as never,sms,'wallet','different')).rejects.toThrow('BILLING_CAPTURED_ACCOUNT_MISMATCH');
    await expect(assertCapturedPrepaidSource(tx as never,{...sms,tariffId:'sms-quote:foreign'},'wallet','receipt')).rejects.toThrow('BILLING_CAPTURED_ACCOUNT_MISMATCH');
  });
  it('requires an exact inbound receipt and standing allocation',async()=>{
    const tx=fixture(),accountSid=`AC${'a'.repeat(32)}`,messageSid=`SM${'b'.repeat(32)}`;
    tx.billingSmsInboundReceipt.findUnique.mockResolvedValue({id:'inbound',orgId:'org',teamId:'team',serviceId:'service',
      numberId:'number',allocationId:'allocation',standingHoldId:'standing',accountSid,messageSid});
    const standing={...common,numberId:'number',allocationId:'allocation',requestedByUserId:'human'};
    tx.billingSmsStandingHold.findUnique.mockResolvedValue(standing);
    const inbound={...hold,providerServiceId:'twilio-sms',dispatchId:`sms-inbound:${accountSid}:${messageSid}`};
    await assertCapturedPrepaidSource(tx as never,inbound,'wallet',messageSid);
    tx.billingSmsStandingHold.findUnique.mockResolvedValue({...standing,allocationId:'other'});
    await expect(assertCapturedPrepaidSource(tx as never,inbound,'wallet',messageSid)).rejects.toThrow('BILLING_CAPTURED_ACCOUNT_MISMATCH');
  });
  it('retains the exact LLM reservation path',async()=>{
    const tx=fixture();await assertCapturedPrepaidSource(tx as never,{...hold,providerServiceId:'llm'},'wallet','receipt');
    expect(tx.billingVoiceReservation.findUnique).not.toHaveBeenCalled();
    expect(tx.billingPrepaidReservation.findUnique).toHaveBeenCalledWith(expect.objectContaining({where:{dispatchId:'dispatch'}}));
  });
});
