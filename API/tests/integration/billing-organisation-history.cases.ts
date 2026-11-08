import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { billingCycleDetailV2ConformanceFixture } from '../../src/contracts/billing-statement-v1.js';
import { billingCycleSnapshotDigest,listBillingCycles,getBillingCycleDetail } from '../../src/services/billing-cycle-read.service.js';
import { listCustomerInvoices,getCustomerInvoiceDetail } from '../../src/services/billing-customer-invoice-read.service.js';
import { db,orgId,ownerId,teamManagerId,accountId,serviceId,product,context } from './billing-stripe-payment-invoice.suite-fixture.js';

export function registerOrganisationHistoryCases(){
  it('reads captured org financial history across products/teams with account-bound keysets',async()=>{
    const base=context(teamManagerId),viewer={...base,financialScope:'organisation' as const,billingMode:'sandbox' as const};
    const account=await db.prisma.billingStripeAccount.findUniqueOrThrow({where:{id:accountId}});
    const customer=await db.prisma.billingStripeCustomer.findFirstOrThrow({where:{orgId,accountId,scope:'ORGANISATION'}});
    const wallet=await db.prisma.billingCreditAccount.create({data:{orgId,accountId,customerId:customer.id,scope:'ORGANISATION',scopeKey:orgId,currency:'USD'}});
    const otherService=await db.prisma.billingService.create({data:{identifier:'other-'+randomUUID(),name:'Other product'}});
    const otherTeam=await db.prisma.team.create({data:{orgId,name:'Other financial team',slug:'other-financial'}});
    const ids:string[]=[];
    for(const [service,team] of [[{id:serviceId,identifier:product},base.request.teamId!],[otherService,otherTeam.id]] as const){
      const id=randomUUID();const snapshot={...billingCycleDetailV2ConformanceFixture,cycle_id:id,state:'pending_reconciliation',
        period:{month:'2026-08',starts_at:'2026-08-01T00:00:00.000Z',ends_at:'2026-09-01T00:00:00.000Z'},
        scope:{organisation_id:orgId,team_id:team,cycle_scope:'team',payer_scope:'organisation'},
        product:{id:service.id,identifier:service.identifier,name:'Financial product'},totals:[],subscription_lines:[],usage_lines:[],
        documents:[],document_available:false,adjustments:[],credits:{consumed:null,opening_balance:null,closing_balance:null,status:'pending_reconciliation'}};
      const evidence={source:'team_usage_only',wallet_boundary:{account_id:wallet.id}};
      await db.prisma.billingCustomerCycle.create({data:{id,orgId,teamId:team,serviceId:service.id,billingMonth:'2026-08',
        revision:1,state:'pending_reconciliation',payerScope:'ORGANISATION',publicSnapshot:snapshot,privateEvidence:evidence,
        snapshotSha256:billingCycleSnapshotDigest(snapshot,evidence)}});ids.push(id);
    }
    const first=await listBillingCycles(viewer,{limit:1},{prisma:db.prisma});expect(first.cycles).toHaveLength(1);expect(first.next_cursor).toBeTruthy();
    const second=await listBillingCycles(viewer,{limit:1,cursor:first.next_cursor!},{prisma:db.prisma});
    expect(new Set([...first.cycles,...second.cycles].map(row=>row.cycle_id))).toEqual(new Set(ids));
    expect(second.next_cursor).toBeNull();
    expect((await getBillingCycleDetail({...viewer,request:{...viewer.request,teamId:null,userId:ownerId}},ids[1],{prisma:db.prisma})).product.identifier)
      .toBe(otherService.identifier);
    const live=await db.prisma.billingStripeAccount.upsert({where:{stripeAccountId_livemode:{stripeAccountId:account.stripeAccountId,livemode:true}},
      create:{stripeAccountId:account.stripeAccountId,livemode:true},update:{}});
    expect((await listBillingCycles({...viewer,billingMode:'live'},{},{prisma:db.prisma})).cycles).toEqual([]);
    await expect(getBillingCycleDetail({...viewer,billingMode:'live'},ids[0],{prisma:db.prisma})).rejects.toMatchObject({statusCode:404});
    await expect(listBillingCycles({...viewer,billingMode:'live'},{cursor:first.next_cursor!},{prisma:db.prisma})).rejects.toMatchObject({statusCode:400});
    expect(live.id).not.toBe(accountId);expect(await db.prisma.billingCreditEntry.count({where:{creditAccountId:wallet.id}})).toBe(0);
    // The presenting product is an actor audience. It cannot hide another
    // registered product's financial history from this org's manager.
    const consumer={...viewer,credential:{...viewer.credential,service:{id:otherService.id,identifier:otherService.identifier,name:'Other product'}},
      request:{...viewer.request,product:otherService.identifier}};
    const invoices=await listCustomerInvoices(consumer,{chargeMonth:'2026-10'},{prisma:db.prisma});
    const source=invoices.invoices.find(row=>row.kind==='monthly_service');expect(source).toBeTruthy();
    const detail=await getCustomerInvoiceDetail(consumer,source!.invoice_id,{prisma:db.prisma});expect(detail.product_identifiers).toContain(product);
    expect(detail.scope.organisation_id).toBe(orgId);
  });
}
