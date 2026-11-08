import { createHash,randomUUID } from 'node:crypto';
import { BillingAssignmentScope,BillingCollectionMode,BillingMonthlyChargeBasis,BillingTariffMode,BillingTariffSource } from '@prisma/client';
import { billingCycleDetailV2ConformanceFixture } from '../../src/contracts/billing-statement-v1.js';
import { billingCycleSnapshotDigest,type BillingCycleContext } from '../../src/services/billing-cycle-read.service.js';
import { createTestDb } from './test-db.js';
import { captureTestOrganisationFinancialBinding,createTestCapturedPaidLiability } from './organisation-financial-binding.js';
export async function seedCycleScopeFixture(){

    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    const db = created;
    const owner = await db.prisma.user.create({ data: { email: `${randomUUID()}@example.com`,
      userKey: `${randomUUID()}@example.com`, name: 'Owner' } });
    const manager = await db.prisma.user.create({ data: { email: `${randomUUID()}@example.com`,
      userKey: `${randomUUID()}@example.com`, name: 'Team Manager' } });
    const ownerId = owner.id;
    const teamManagerId = manager.id;
    const org = await db.prisma.organisation.create({ data: { domain: `${randomUUID()}.example.com`,
      name: 'Billing Scope Test', slug: `scope-${randomUUID().slice(0, 10)}`, ownerId } });
    const orgId = org.id;
    const team = await db.prisma.team.create({ data: { orgId, name: 'Selected Team',
      slug: `team-${randomUUID().slice(0, 10)}` } });
    const teamId = team.id;
    const service = await db.prisma.billingService.create({ data: {
      identifier: `billing-scope-${randomUUID()}`, name: 'Scope Service',
      tariffHistoryFromMonth: '2030-01',
    } });
    const serviceId = service.id;
    const serviceIdentifier = service.identifier;
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId, key: 'standard', version: 1, name: 'Standard',
      mode: BillingTariffMode.STANDARD, collectionMode: BillingCollectionMode.MANUAL,
      markupBps: 3000, monthlyAmountMinor: 2000n,
      monthlyChargeBasis: BillingMonthlyChargeBasis.FLAT, currency: 'USD',
    } });
    const tariffId = tariff.id;
    const usageOnlyTariff = await db.prisma.billingTariff.create({ data: {
      serviceId, key: 'usage-only', version: 1, name: 'Usage only',
      mode: BillingTariffMode.STANDARD, collectionMode: BillingCollectionMode.MANUAL,
      markupBps: 3000, monthlyAmountMinor: 0n,
      monthlyChargeBasis: BillingMonthlyChargeBasis.FLAT, currency: 'USD',
    } });
    const usageOnlyTariffId = usageOnlyTariff.id;
    await db.prisma.billingTariffTermEvent.create({ data: {
      serviceId, source: BillingTariffSource.SERVICE_DEFAULT, scopeKey: serviceId,
      effectiveFromMonth: '2030-01', tariffId: usageOnlyTariff.id,
      reason: 'test_seed',
    } });
    await db.prisma.orgMember.createMany({ data: [
      { orgId, userId: ownerId, role: 'owner' },
      { orgId, userId: teamManagerId, role: 'member' },
    ] });
    await db.prisma.teamMember.createMany({ data: [
      { teamId, userId: ownerId, teamRole: 'owner' },
      { teamId, userId: teamManagerId, teamRole: 'owner' },
    ] });
  const binding=await captureTestOrganisationFinancialBinding(db.prisma,orgId);
  const account=await db.prisma.billingStripeAccount.findUniqueOrThrow({where:{id:binding.billingAccountId}});
  const customer=await db.prisma.billingStripeCustomer.create({data:{accountId:account.id,orgId,teamId:null,scope:'ORGANISATION',scopeKey:orgId}});
  const wallet=await db.prisma.billingCreditAccount.create({data:{accountId:account.id,customerId:customer.id,orgId,teamId:null,scope:'ORGANISATION',scopeKey:orgId,currency:'USD'}});
  const app=await db.prisma.billingAppKey.create({data:{serviceId,purpose:'CUSTOMER_LIFECYCLE',name:'Cycle source',keyPrefix:'cycle',secretDigest:randomUUID(),actorIssuer:'https://test.example',actorAudience:'https://uoa.test',actorKeyId:randomUUID(),actorPublicJwk:{kty:'RSA',n:'AQAB',e:'AQAB'},checkoutReturnOrigins:['https://test.example']}});
  const sources=new Map<string,{kind:'stripe';id:string}>();
  async function sourceFor(team:string|null,tariff=tariffId) {
    const key=`${team}:${tariff}`;const existing=sources.get(key);if(existing)return existing;
    // Captured subscription fixture only. The actual close/proof/history paths
    // below use normal production guards, including exact provider account.
    const row=await db.prisma.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      const payer=team?'TEAM':'ORGANISATION';const scopeKey=team?`${orgId}:${team}`:orgId;
      const cust=team?await tx.billingStripeCustomer.create({data:{accountId:account.id,orgId,teamId:team,scope:payer,scopeKey}}):customer;
      const checkout=await tx.billingStripeCheckoutSession.create({data:{createdAt:new Date('2026-01-01T00:00:00Z'),
        accountId:account.id,customerId:cust.id,appKeyId:app.id,serviceId,tariffId:tariff,tariffSource:'SERVICE_DEFAULT',orgId,teamId:team,scope:payer,scopeKey,
        actorJti:randomUUID(),requestedByUserId:ownerId,successUrlDigest:'a'.repeat(64),cancelUrlDigest:'b'.repeat(64),leaseExpiresAt:new Date('2030-01-01T00:00:00Z')}});
      return tx.billingStripeSubscription.create({data:{createdAt:new Date('2026-01-01T00:00:00Z'),accountId:account.id,customerId:cust.id,checkoutId:checkout.id,
        serviceId,tariffId:tariff,tariffSource:'SERVICE_DEFAULT',orgId,teamId:team,scope:payer,scopeKey,stripeSubscriptionId:`sub_${randomUUID()}`,stripeUsageItemId:`si_${randomUUID()}`,status:'active',livemode:true}});
    });const value={kind:'stripe' as const,id:row.id};sources.set(key,value);return value;
  }
  async function recordPaidLiability(month: string, billedTeamId: string,
    cost: string, ratedMicrocredits: bigint, frozenTariffId = usageOnlyTariffId) {
    const data = {
      dispatchId: `dispatch-${randomUUID()}`, receiptId: `receipt-${randomUUID()}`,
      serviceId, providerServiceId: 'model-synthetic', orgId, teamId: billedTeamId,
      userId: ownerId, billingMonth: month, currency: 'USD', tariffId: frozenTariffId,
      frozenMarkupBps: 3000, paymentMode: 'PAY_AS_YOU_GO' as const, rawCostActual: cost,
      ratedQuanta: '0', ratedMicrocredits,
    };
    if(await db.prisma.team.findUnique({where:{id:billedTeamId}})) return createTestCapturedPaidLiability(db.prisma,{data});
    // Retained receipt from a removed historical team: import its captured
    // dispatch only; production close/history never disables constraints.
    return db.prisma.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.billingCreditBudgetDispatch.create({data:{...binding,dispatchId:data.dispatchId,contextDigest:'a'.repeat(64),
        serviceId,providerServiceId:data.providerServiceId,orgId,teamId:billedTeamId,userId:ownerId,
        billingMonth:month,currency:'USD',tariffId:frozenTariffId,tariffMode:'CUSTOM',frozenMarkupBps:3000,paymentMode:'PAY_AS_YOU_GO'}});
      return tx.billingPaidUsageLiability.create({data});
    });
  }

  async function fetchPaidReceiptSet(scope: { product: string; organisationId: string;
    teamId: string; serviceId: string; billingMonth: string }) {
    const rows = await db.prisma.billingPaidUsageLiability.findMany({ where: {
      serviceId: scope.serviceId, orgId: scope.organisationId,
      teamId: scope.teamId, billingMonth: scope.billingMonth,
    } });
    rows.sort((a, b) => Buffer.compare(Buffer.from(a.dispatchId), Buffer.from(b.dispatchId)));
    const hash = createHash('sha256').update('ledger-paid-receipt-set-v1:paid\n');
    for (const row of rows) hash.update(JSON.stringify([
      row.dispatchId, row.receiptId, row.rawCostActual.toFixed(18),
    ])).update('\n');
    return { contract: 'ledger-paid-receipt-set-v1' as const,
      scope: { billing_product: scope.product, organization_id: scope.organisationId,
        team_id: scope.teamId, billing_month: scope.billingMonth },
      snapshot: { cursor: `mpr_${'a'.repeat(32)}`,
        captured_at: '2030-10-04T00:00:00.000Z', immutable: true as const },
      paid_receipt_count: String(rows.length), paid_receipt_sha256: hash.digest('hex'),
      zero_incremental_count: '0', zero_incremental_sha256: createHash('sha256')
        .update('ledger-paid-receipt-set-v1:zero\n').digest('hex'),
      unresolved_paid_attempts: '0', signature: 'test-boundary-verified-signature'.repeat(4) };
  }

  function context(userId: string): BillingCycleContext {
    return { credential: { service: { id: serviceId, identifier: serviceIdentifier,
      name: 'Scope Service' } } as BillingCycleContext['credential'],
    actorToken: 'test-signed-actor', endpoint: '/billing/v1/cycles/list',
    request: { product: serviceIdentifier, organisationId: orgId, teamId, userId } };
  }

  async function insertCycle(month: string, scope: 'team' | 'organisation',
    payer: BillingAssignmentScope, revision = 1) {
    const id = randomUUID();
    const team = scope === 'team' ? teamId : null;
    const startsAt = new Date(`${month}-01T00:00:00.000Z`);
    const endsAt = new Date(Date.UTC(startsAt.getUTCFullYear(), startsAt.getUTCMonth() + 1, 1));
    const publicSnapshot = { ...billingCycleDetailV2ConformanceFixture,
      cycle_id: id, schema_version: 2, state: 'finalized',
      period: { month, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() },
      scope: { organisation_id: orgId, team_id: team, cycle_scope: scope,
        payer_scope: payer.toLowerCase() },
      product: { id: serviceId, identifier: serviceIdentifier, name: 'Scope Service' },
      documents: [], document_available: false };
    const privateEvidence = { quote:{source:await sourceFor(team,usageOnlyTariffId)}, revision };
    return db.prisma.billingCustomerCycle.create({ data: {
      id, serviceId, orgId, teamId: team, billingMonth: month, revision,
      state: 'finalized', payerScope: payer, publicSnapshot, privateEvidence,
      snapshotSha256: billingCycleSnapshotDigest(publicSnapshot, privateEvidence),
    } });
  }

  return {db,serviceId,orgId,teamId,ownerId,teamManagerId,tariffId,usageOnlyTariffId,serviceIdentifier,account,customer,wallet,recordPaidLiability,fetchPaidReceiptSet,context,insertCycle,sourceFor};
}
