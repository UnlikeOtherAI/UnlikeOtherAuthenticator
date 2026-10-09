import { Prisma, type PrismaClient } from '@prisma/client';
import type { VerifiedBillingAppKey } from '../../src/services/billing-app-key.service.js';
import { BillingSmsProvider } from '../../src/services/billing-sms-provider.service.js';

export const smsIds = { user: 'sms-user', org: 'sms-org', team: 'sms-team', service: 'sms-service',
  account: 'sms-stripe-account', customer: 'sms-customer', credit: 'sms-credit', runtime: 'sms-runtime',
  lifecycle: 'sms-lifecycle', quote: 'sms-inbound-quote', number: 'sms-number', fx: 'sms-fx', policy: 'sms-policy' };
export const smsAccount = `AC${'a'.repeat(32)}`;
export const smsPhone = '+420777000001';
export const smsCredential: VerifiedBillingAppKey = {
  id: smsIds.runtime, purpose: 'SMS_RUNTIME', actorIssuer: 'https://authentication.unlikeotherai.com',
  actorAudience: 'https://authentication.unlikeotherai.com', actorKeyId: 'synthetic',
  actorPublicJwk: {}, checkoutReturnOrigins: [], service: { id: smsIds.service, identifier: 'nessie', name: 'Nessie' },
};
export async function seedSmsFinance(prisma: PrismaClient, createNumber = true): Promise<void> {
  const id = smsIds;
  await prisma.$transaction(async (tx) => {
    // Existing test convention: establish synthetic canonical wallet opening evidence only.
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`INSERT INTO users(id,email,user_key,name)
      VALUES (${id.user},'sms@example.test','sms@example.test','SMS fixture')`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO organisations(id,domain,name,slug,owner_id,updated_at)
      VALUES (${id.org},'sms.example.test','SMS','sms',${id.user},CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO teams(id,org_id,name,slug,updated_at)
      VALUES (${id.team},${id.org},'SMS','sms',CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO org_members(id,org_id,user_id,domain,role,updated_at)
      VALUES ('sms-org-member',${id.org},${id.user},'sms.example.test','owner',CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO team_members(id,team_id,user_id,team_role,updated_at)
      VALUES ('sms-team-member',${id.team},${id.user},'admin',CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO billing_services(id,identifier,name,updated_at)
      VALUES (${id.service},'nessie','Nessie',CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO billing_stripe_accounts(id,stripe_account_id,livemode,updated_at)
      VALUES (${id.account},'acct_sms_fixture',false,CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO billing_stripe_customers(id,account_id,org_id,team_id,scope,scope_key,updated_at)
      VALUES (${id.customer},${id.account},${id.org},${id.team},'TEAM',${`${id.org}:${id.team}`},CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO billing_credit_accounts
      (id,account_id,customer_id,org_id,team_id,scope,scope_key,currency,balance_microcredits,updated_at)
      VALUES (${id.credit},${id.account},${id.customer},${id.org},${id.team},'TEAM',${`${id.org}:${id.team}`},
        'USD',100000000,CURRENT_TIMESTAMP)`);
  });
  for (const [key, purpose] of [[id.runtime, 'SMS_RUNTIME'], [id.lifecycle, 'CUSTOMER_LIFECYCLE']] as const) {
    await prisma.billingAppKey.create({ data: { id: key, serviceId: id.service, purpose,
      name: 'Synthetic SMS test', keyPrefix: key, secretDigest: key,
      checkoutReturnOrigins: purpose === 'CUSTOMER_LIFECYCLE' ? ['https://app.example.test'] : [],
      actorIssuer: smsCredential.actorIssuer, actorAudience: smsCredential.actorAudience,
      actorKeyId: 'synthetic', actorPublicJwk: {} } });
  }
  const created = new Date(Date.now() - 60_000);
  const expiry = new Date(Date.now() + 3_600_000);
  await prisma.billingSmsFxSnapshot.create({ data: { id: id.fx, policy: 'ECB_REFERENCE_USD_PER_EUR_V1',
    source: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', sourceDigest: 'a'.repeat(64),
    rateDate: created, observedAt: created, acceptedAt: created, expiresAt: expiry,
    usdPerEur: '1.1', acceptedByUserId: id.user, acceptanceReason: 'Synthetic fixture' } });
  await prisma.billingSmsRoutePolicy.create({ data: { id: id.policy, accountSid: smsAccount,
    country: 'CZ', direction: 'inbound', currency: 'USD', additionalPerSegment: '0.002', additionalPerMessage: '0.001',
    source: 'https://www.twilio.com/docs/messaging/api/pricing', evidenceDigest: 'b'.repeat(64),
    expiresAt: expiry, acceptedAt: created, acceptedByUserId: id.user, acceptanceReason: 'Synthetic route evidence' } });
  await prisma.billingSmsQuote.create({ data: { commercialPolicyVersion: 'synthetic-policy', monthlyFeeEur: '7.25', messageMarkupBps: 2700, id: id.quote, serviceId: id.service, appKeyId: id.lifecycle,
    orgId: id.org, country: 'CZ', direction: 'inbound', destination: null,
    providerAmount: '0.01', providerBoundAmount: '0.013', providerCurrency: 'USD',
    providerSource: 'https://pricing.twilio.com/v1/Messaging/Countries/CZ', providerObservedAt: created,
    fxSnapshotId: id.fx, routePolicyId: id.policy, finalAmount: '0.01651', finalCurrency: 'USD',
    rateBasis: 'inbound_mobile', expiresAt: expiry, createdAt: created } });
  if (createNumber) await prisma.billingSmsNumberResource.create({ data: { id: id.number, serviceId: id.service,
    appKeyId: id.lifecycle, orgId: id.org, quoteId: id.quote, phoneNumber: smsPhone,
    country: 'CZ', accountSid: smsAccount, phoneNumberSid: `PN${'a'.repeat(32)}`, state: 'active', createdAt: created } });
}

export async function smsStanding(prisma: PrismaClient, allocation: string, amount: bigint) {
  const hold = await prisma.billingSmsStandingHold.create({ data: { creditAccountId: smsIds.credit,
    serviceId: smsIds.service, appKeyId: smsIds.lifecycle, orgId: smsIds.org, teamId: smsIds.team,
    numberId: smsIds.number, allocationId: allocation, quoteId: smsIds.quote,
    requestedByUserId: smsIds.user, idempotencyKey: allocation, reservedMicrocredits: amount } });
  await prisma.billingSmsStandingFunding.create({ data: { serviceId: smsIds.service, appKeyId: smsIds.lifecycle,
    holdId: hold.id, quoteId: smsIds.quote, idempotencyKey: allocation, addedMicrocredits: amount,
    requestedByUserId: smsIds.user, createdAt: new Date(Date.now() - 30_000) } });
  return hold;
}

export function smsReceiptProvider(amount: string | null, segments: string | null = '1', created?: Date) {
  const provider = new BillingSmsProvider({ accountSid: smsAccount, apiKeySid: `SK${'b'.repeat(32)}`,
    apiKeySecret: 'synthetic-unused-secret' }, async (url) => {
    const sid = /Messages\/(SM[\da-f]+)\.json/.exec(String(url))?.[1];
    return new Response(JSON.stringify({ sid, account_sid: smsAccount, from: '+420777000002',
      to: smsPhone, direction: 'inbound', status: 'received', price: amount === null ? null : `-${amount}`,
      price_unit: amount === null ? null : 'usd', num_segments: segments,
      date_created: (created ?? new Date(Date.now() - 5000)).toUTCString() }), { status: 200 });
  });
  return provider;
}
