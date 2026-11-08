import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createRlsTestDb } from '../helpers/test-db.js';
import { loadAddonData } from '../../src/services/billing-recurring-addon-data.service.js';

describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS!=='true')('ORG-paid add-on database authority',()=>{
  let db:PrismaClient,cleanup:()=>Promise<void>,epoch:Date;
  beforeAll(async()=>{
    const handle=await createRlsTestDb();if(!handle)throw Error('Disposable PG required');db=handle.prisma;cleanup=handle.cleanup;
    epoch=(await db.$queryRaw<Array<{at:Date}>>`SELECT activated_at AS at FROM billing_organisation_scope_cutover WHERE id=1`)[0].at;
    await db.user.createMany({data:['owner','admin','member'].map(id=>({id,email:`${id}@addon.example.test`,userKey:id}))});
    await db.organisation.create({data:{id:'addon-org',domain:'addon.example.test',name:'Org addons',slug:'addons',ownerId:'owner'}});
    await db.orgMember.createMany({data:['owner','admin','member'].map(id=>({orgId:'addon-org',userId:id,role:id==='owner'?'owner':'member'}))});
    await db.team.createMany({data:['selected','managed'].map(id=>({id,orgId:'addon-org',name:id,slug:id}))});
    await db.teamMember.createMany({data:[{teamId:'selected',userId:'admin',teamRole:'member'},
      {teamId:'managed',userId:'admin',teamRole:'admin'},{teamId:'selected',userId:'member',teamRole:'member'}]});
    await db.billingStripeAccount.create({data:{id:'addon-live',stripeAccountId:'acct_AddonAuthority',livemode:true}});
    await db.billingService.create({data:{id:'addon-service',identifier:'addon-proof',name:'Addon proof'}});
    await db.billingAppKey.create({data:{id:'addon-app',serviceId:'addon-service',purpose:'CUSTOMER_LIFECYCLE',name:'Addon',
      keyPrefix:'addon-key',secretDigest:'a'.repeat(64),actorIssuer:'https://addon.example.test',actorAudience:'https://uoa.example.test',
      actorKeyId:'addon-key',actorPublicJwk:{kty:'RSA',n:'AQAB',e:'AQAB'},checkoutReturnOrigins:['https://addon.example.test']}});
    await db.billingStripeCustomer.create({data:{id:'org-customer',accountId:'addon-live',orgId:'addon-org',scope:'ORGANISATION',scopeKey:'addon-org',stripeCustomerId:'cus_addon_org'}});
    for(const key of ['team','user','org','org-null']){
      await db.billingRecurringAddonOffer.create({data:{id:`offer-${key}`,serviceId:'addon-service',key,version:1,name:key,description:key,monthlyAmountMinor:500n,currency:'USD'}});
      await db.billingRecurringAddonCatalog.create({data:{id:`catalog-${key}`,offerId:`offer-${key}`,serviceId:'addon-service',accountId:'addon-live',
        currency:'USD',monthlyAmountMinor:500n,stripeLookupKey:`addon-${key}`,stripeProductId:`prod_${key}`,stripePriceId:`price_${key}`}});
    }
  });
  afterAll(async()=>{await cleanup?.();});
  async function checkout(key:'team'|'user'|'org'|'org-null',actor:string,selected:string|null='selected'){
    const jti=randomUUID();await db.billingCustomerActionIntent.create({data:{appKeyId:'addon-app',serviceId:'addon-service',orgId:'addon-org',
      teamId:selected,requestedByUserId:actor,authorityScope:'ORGANISATION',operation:'recurring_addon_checkout',actorJti:jti,
      actorTokenVersion:0,actorExpiresAt:new Date(Date.now()+60_000),requestDigest:'b'.repeat(64)}});
    return db.billingRecurringAddonCheckout.create({data:{accountId:'addon-live',appKeyId:'addon-app',serviceId:'addon-service',
      customerId:'org-customer',catalogId:`catalog-${key}`,offerId:`offer-${key}`,offerKey:key,orgId:'addon-org',
      teamId:key.startsWith('org')?null:selected,requestedTeamId:selected,subscribingUserId:key==='user'?actor:null,
      scope:key.startsWith('org')?'ORGANISATION':key==='team'?'TEAM':'SUBSCRIBING_USER',
      scopeKey:key.startsWith('org')?'addon-org':key==='team'?`addon-org:${selected}`:`addon-org:${selected}:${actor}`,
      requestedByUserId:actor,actorJti:jti,subjectFingerprint:'c'.repeat(64),successUrlDigest:'d'.repeat(64),cancelUrlDigest:'e'.repeat(64),
      leaseExpiresAt:new Date(Date.now()+60_000),billingModeTeamId:selected,billingModeRevision:0,billingScopeEpoch:epoch}});
  }
  it('captures TEAM and USER entitlements with the exact ORG payer for an org owner without membership',async()=>{
    for(const key of ['team','user'] as const){const row=await checkout(key,'owner');expect(row.customerId).toBe('org-customer');expect(row.accountId).toBe('addon-live');}
    expect(await db.teamMember.count({where:{userId:'owner'}})).toBe(0);
  });
  it('refuses team-only managers and admits current organisation administration without team membership',async()=>{
    await expect(checkout('org','admin')).rejects.toThrow('BILLING_MANAGER_REQUIRED');
    await expect(checkout('org','member')).rejects.toThrow('current exact authority');
    await expect(checkout('org','admin',null)).rejects.toThrow('current exact authority');
    await db.orgMember.update({where:{orgId_userId:{orgId:'addon-org',userId:'admin'}},data:{role:'admin'}});
    const row=await checkout('org','admin');expect(row.teamId).toBeNull();
    const nullOwner=await checkout('org-null','owner',null);expect(nullOwner.requestedTeamId).toBeNull();
  });
  it('keeps pending current ORG customer work visible with nullable finance admission',async()=>{
    const rows=await loadAddonData({accountId:'addon-live',serviceId:'addon-service',organisationId:'addon-org',teamId:null},{prisma:db});
    expect(rows.checkouts).toHaveLength(4);expect(rows.retainedSubscriptions).toEqual([]);
    expect(rows.checkouts.every(row=>row.customerId==='org-customer')).toBe(true);
    expect(await db.billingStripeWebhookEvent.count()).toBe(0);expect(await db.billingCreditEntry.count()).toBe(0);
  });
});
