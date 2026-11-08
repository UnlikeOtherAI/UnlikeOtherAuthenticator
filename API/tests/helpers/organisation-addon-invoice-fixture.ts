import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { applyRecurringAddonWebhook } from '../../src/services/billing-recurring-addon-webhook-apply.service.js';
import { recurringAddonMetadata } from '../../src/services/billing-recurring-addon-stripe-binding.service.js';
import { seedOrganisationConsent } from './organisation-consent-fixture.js';

/** Captures two real DB checkout/subscription sources under one ORG payer.
 * Provider boundaries are synthetic; no DB guards are disabled. */
export async function seedOrganisationAddonInvoices(db:PrismaClient,options:{providerSpies?:boolean;product?:string;tariffHistoryFromMonth?:string;
  period?:{startsAt:Date;endsAt:Date;paidAt:Date}}={}) {
  const vitest=options.providerSpies===false?null:(await import('vitest')).vi;
  function spy<T extends(...args:never[])=>unknown>(fn:T):T{return vitest?vitest.fn(fn) as unknown as T:fn;}
  const seed=await seedOrganisationConsent(db,options),{account,selection}=seed;
  await db.team.create({data:{id:'addon-other-team',orgId:'control-org',name:'Other',slug:'other'}});
  await db.billingRecurringAddonOffer.create({data:{id:'invoice-addon-offer',serviceId:'control-service',key:'privacy',version:1,
    name:'Private research',description:'Private research',monthlyAmountMinor:5000n,currency:'USD'}});
  await db.billingRecurringAddonCatalog.create({data:{id:'invoice-addon-catalog',accountId:account.id,serviceId:'control-service',
    offerId:'invoice-addon-offer',currency:'USD',monthlyAmountMinor:5000n,stripeLookupKey:'privacy-usd-v1',stripeProductId:'prod_privacy',stripePriceId:'price_privacy'}});
  const {startsAt,endsAt,paidAt}=options.period??{startsAt:new Date('2030-01-01T00:00:00Z'),endsAt:new Date('2030-02-01T00:00:00Z'),paidAt:new Date('2030-01-03T00:00:00Z')};
  const sources:Array<{suffix:'a'|'b';remote:Stripe.Subscription;invoice:Stripe.Invoice;paidAt:Date;
    subscription:Awaited<ReturnType<typeof db.billingRecurringAddonSubscription.findUniqueOrThrow>>}>=[];
  for(const [suffix,teamId] of [['a','control-team'],['b','addon-other-team']] as const){
    await db.billingCustomerActionIntent.create({data:{appKeyId:seed.credential.id,serviceId:'control-service',orgId:'control-org',teamId,
      requestedByUserId:'control-owner',authorityScope:'ORGANISATION',operation:'recurring_addon_checkout',actorJti:`addon-${suffix}`,
      actorTokenVersion:0,actorExpiresAt:new Date(Date.now()+60000),requestDigest:'e'.repeat(64)}});
    const checkout=await db.billingRecurringAddonCheckout.create({data:{id:`invoice-checkout-${suffix}`,accountId:account.id,
      appKeyId:seed.credential.id,customerId:'control-customer',catalogId:'invoice-addon-catalog',serviceId:'control-service',
      offerId:'invoice-addon-offer',offerKey:'privacy',orgId:'control-org',teamId,requestedTeamId:teamId,scope:'TEAM',scopeKey:`control-org:${teamId}`,
      actorJti:`addon-${suffix}`,subjectFingerprint:'f'.repeat(64),requestedByUserId:'control-owner',successUrlDigest:'a'.repeat(64),
      cancelUrlDigest:'b'.repeat(64),leaseExpiresAt:new Date(Date.now()+60000),billingModeTeamId:teamId,billingModeRevision:selection.revision,
      billingScopeEpoch:new Date(selection.epoch)},include:{catalog:true,customer:true}});
    await db.billingRecurringAddonCheckout.update({where:{id:checkout.id},data:{status:'OPEN',stripeCheckoutSessionId:`cs_addon_${suffix}`}});
    const metadata=recurringAddonMetadata(checkout,account);
    const item={id:`si_addon_${suffix}`,quantity:1,discounts:[],current_period_start:startsAt.getTime()/1000,
      current_period_end:endsAt.getTime()/1000,price:{id:'price_privacy',recurring:{interval:'month',usage_type:'licensed'}}};
    const remote={id:`sub_addon_${suffix}`,object:'subscription',livemode:true,customer:'cus_controls',metadata,status:'active',
      cancel_at_period_end:false,discounts:[],items:{data:[item]},automatic_tax:{enabled:false},default_tax_rates:[]};
    const session={id:`cs_addon_${suffix}`,expires_at:Math.floor(Date.now()/1000)+600};
    const completed=await db.billingStripeWebhookEvent.create({data:{accountId:account.id,stripeEventId:`evt_addon_checkout_${suffix}`,
      type:'checkout.session.completed',livemode:true,stripeCreatedAt:paidAt,stripeObjectId:session.id,stripeCheckoutSessionId:session.id,
      stripeCustomerId:'cus_controls',stripeSubscriptionId:remote.id}});
    await db.$transaction(tx=>applyRecurringAddonWebhook(tx,{kind:'checkout_completed',checkout,session,subscription:remote,item,
      eventAt:paidAt,eventFields:{}} as never,completed.id,account));
    const subscription=await db.billingRecurringAddonSubscription.findUniqueOrThrow({where:{checkoutId:checkout.id}});
    const line={id:`il_addon_${suffix}`,amount:5000,subtotal:5000,currency:'usd',quantity:1,discounts:[],discount_amounts:[],
      pretax_credit_amounts:[],taxes:[],period:{start:startsAt.getTime()/1000,end:endsAt.getTime()/1000},
      parent:{type:'subscription_item_details',subscription_item_details:{proration:false,subscription:remote.id,subscription_item:item.id}},
      pricing:{price_details:{price:'price_privacy'},unit_amount_decimal:'5000'}};
    const invoice={id:`in_addon_${suffix}`,object:'invoice',created:startsAt.getTime()/1000,livemode:true,status:'paid',customer:'cus_controls',currency:'usd',
      parent:{type:'subscription_details',subscription_details:{subscription:remote.id,metadata}},billing_reason:'subscription_create',
      collection_method:'charge_automatically',amount_due:5000,amount_paid:5000,amount_remaining:0,subtotal:5000,total:5000,
      starting_balance:0,amount_shipping:0,pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0,discounts:[],
      total_discount_amounts:[],total_pretax_credit_amounts:[],total_taxes:[],default_tax_rates:[],lines:{data:[line],has_more:false},
      automatic_tax:{enabled:false},number:`ADDON-${suffix}`,account_name:'Issuer Ltd',account_country:'GB',customer_name:'Buyer Ltd',
      customer_email:'buyer@example.test',customer_address:{country:'GB',line1:'Road'},status_transitions:{finalized_at:startsAt.getTime()/1000},
      invoice_pdf:`https://pay.stripe.com/invoice/addon-${suffix}.pdf`,effective_at:null};
    sources.push({suffix,remote:remote as unknown as Stripe.Subscription,subscription,invoice:invoice as unknown as Stripe.Invoice,paidAt});
  }
  let event:unknown;
  const sourceFor=(id:string)=>sources.find(row=>[row.invoice.id,row.remote.id,`pi_addon_${row.suffix}`,`ch_addon_${row.suffix}`].includes(id))!;
  const stripe={accounts:{retrieveCurrent:spy(async()=>({id:account.stripeAccountId}))},
    subscriptions:{retrieve:spy(async(id:string)=>sourceFor(id).remote)},invoices:{retrieve:spy(async(id:string)=>sourceFor(id).invoice),
      list:spy(async({subscription}:{subscription:string})=>({data:sources.filter(row=>row.remote.id===subscription).map(row=>row.invoice),has_more:false}))},
    invoicePayments:{list:spy(async(input:{invoice?:string;payment?:{payment_intent:string}})=>{
      const source=sourceFor(input.invoice??input.payment!.payment_intent);return {data:[{
      id:`inpay_addon_${source.suffix}`,invoice:source.invoice.id,livemode:true,currency:'usd',status:'paid',amount_paid:5000,
      payment:{type:'payment_intent',payment_intent:`pi_addon_${source.suffix}`},status_transitions:{paid_at:paidAt.getTime()/1000}}],has_more:false};})},
    paymentIntents:{retrieve:spy(async(id:string)=>({id,latest_charge:`ch_addon_${sourceFor(id).suffix}`,customer:'cus_controls',currency:'usd',
      livemode:true,status:'succeeded',amount_received:5000}))},
    charges:{retrieve:spy(async(id:string)=>({id,payment_intent:`pi_addon_${sourceFor(id).suffix}`,customer:'cus_controls',currency:'usd',
      livemode:true,status:'succeeded',paid:true,captured:true,amount_captured:5000,refunded:false,amount_refunded:0,disputed:false}))},
    webhooks:{constructEvent:spy(()=>event)}};
  return {...seed,sources,stripe:stripe as unknown as Stripe,startsAt,endsAt,paidAt,setEvent:(index:number)=>{
    const source=sources[index]!;event={id:`evt_addon_invoice_${source.suffix}`,type:'invoice.paid',api_version:'2026-06-24.dahlia',
      account:account.stripeAccountId,livemode:true,created:paidAt.getTime()/1000,data:{object:source.invoice}};return event;}};
}
