import { expect,it,vi } from 'vitest';
import { listCustomerInvoices,getCustomerInvoiceDetail } from '../../src/services/billing-customer-invoice-read.service.js';
import { db,orgId,ownerId,accountId,context } from './billing-stripe-payment-invoice.suite-fixture.js';
export function registerModeHistoryCase(){
  it('keeps future teams in the same org mode and separates explicit LIVE/TEST history',async()=>{
    const team=await db.prisma.team.create({data:{orgId,name:'Future team',slug:'future-team'}});
    const source=await db.prisma.billingStripePaymentInvoice.findFirstOrThrow({where:{orgId,livemode:false}});
    const base=context();const viewer={...base,financialScope:'organisation' as const,billingMode:'sandbox' as const,
      request:{...base.request,teamId:team.id}};
    // The org owner is admitted without a TeamMember for this new team.
    expect(await db.prisma.teamMember.count({where:{teamId:team.id,userId:ownerId}})).toBe(0);
    expect((await listCustomerInvoices(viewer,{chargeMonth:'2026-10'},{prisma:db.prisma})).invoices.some(row=>row.invoice_id==='stripe:'+source.id)).toBe(true);
    expect((await getCustomerInvoiceDetail(viewer,'stripe:'+source.id,{prisma:db.prisma})).invoice_id).toBe('stripe:'+source.id);
    const account=await db.prisma.billingStripeAccount.findUniqueOrThrow({where:{id:accountId}});
    await db.prisma.billingStripeAccount.upsert({where:{stripeAccountId_livemode:{stripeAccountId:account.stripeAccountId,livemode:true}},
      create:{stripeAccountId:account.stripeAccountId,livemode:true},update:{}});
    expect((await listCustomerInvoices({...viewer,billingMode:'live'},{chargeMonth:'2026-10'},{prisma:db.prisma})).invoices).toEqual([]);
    await expect(getCustomerInvoiceDetail({...viewer,billingMode:'live'},'stripe:'+source.id,{prisma:db.prisma})).rejects.toMatchObject({statusCode:404});
    expect((await db.prisma.billingStripePaymentInvoice.findUniqueOrThrow({where:{id:source.id}})).livemode).toBe(false);
  });
  it('refuses another named provider account of the same mode for exact detail and cursor',async()=>{
    const source=await db.prisma.billingStripePaymentInvoice.findFirstOrThrow({where:{orgId,livemode:false}});
    const viewer={...context(),financialScope:'organisation' as const,billingMode:'sandbox' as const};
    const before=await listCustomerInvoices(viewer,{chargeMonth:'2026-10',limit:1},{prisma:db.prisma});
    await db.prisma.billingStripeAccount.create({data:{stripeAccountId:'acct_anotherNamedTest',livemode:false}});
    vi.stubEnv('STRIPE_SANDBOX_ACCOUNT_ID','acct_anotherNamedTest');
    try{
      expect((await listCustomerInvoices(viewer,{chargeMonth:'2026-10'},{prisma:db.prisma})).invoices).toEqual([]);
      await expect(getCustomerInvoiceDetail(viewer,'stripe:'+source.id,{prisma:db.prisma})).rejects.toMatchObject({statusCode:404});
      if(before.next_cursor)await expect(listCustomerInvoices(viewer,{chargeMonth:'2026-10',cursor:before.next_cursor},{prisma:db.prisma})).rejects.toMatchObject({statusCode:400});
    }finally{vi.stubEnv('STRIPE_SANDBOX_ACCOUNT_ID',(await db.prisma.billingStripeAccount.findUniqueOrThrow({where:{id:accountId}})).stripeAccountId);}
  });
}
