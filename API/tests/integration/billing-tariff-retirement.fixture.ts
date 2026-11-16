import type { PrismaClient } from '@prisma/client';

import {
  captureTestOrganisationFinancialBinding,
  createTestSandboxOrganisationPolicy,
} from '../helpers/organisation-financial-binding.js';

/** A live organisation Stripe subscription on one tariff, with the assignment and Checkout it needs. */
export async function createRetirementStripeSubscription(prisma: PrismaClient, input: {
  serviceId: string; tariffId: string; orgId: string; ownerId: string;
}) {
  const { serviceId, tariffId, orgId } = input;
  const org = await prisma.organisation.findUniqueOrThrow({ where: { id: orgId } });
  const assignment = await prisma.billingTariffAssignment.create({ data: {
    serviceId, tariffId, orgId, teamId: null, scope: 'ORGANISATION', scopeKey: orgId } });
  const appKey = await prisma.billingAppKey.create({ data: {
    serviceId, name: 'Retirement app key', keyPrefix: 'uoa_app_retire_stripe',
    secretDigest: 'retirement-stripe-secret-digest', actorIssuer: `https://${org.domain}`,
    actorAudience: 'https://authentication.unlikeotherai.com', actorKeyId: 'retirement-stripe-key',
    actorPublicJwk: { kty: 'RSA', kid: 'retirement-stripe-key', n: 'AQAB', e: 'AQAB' } } });
  const modeTeam = await prisma.team.create({ data: { orgId, name: 'TEST billing team', slug: 'test-billing' } });
  const billingScopeEpoch = await createTestSandboxOrganisationPolicy(prisma, orgId);
  const binding = await captureTestOrganisationFinancialBinding(prisma, orgId,
    { stripeAccountId: 'acct_TariffRetirement', livemode: false });
  const account = await prisma.billingStripeAccount.findUniqueOrThrow({ where: { id: binding.billingAccountId } });
  const customer = await prisma.billingStripeCustomer.create({ data: {
    accountId: account.id, orgId, teamId: null, scope: 'ORGANISATION', scopeKey: orgId,
    stripeCustomerId: 'cus_tariff_retirement' } });
  const scope = { orgId, teamId: null, scope: 'ORGANISATION' as const, scopeKey: orgId };
  const checkout = await prisma.billingStripeCheckoutSession.create({ data: {
    billingModeTeamId: modeTeam.id, billingModeRevision: 1, billingScopeEpoch,
    accountId: account.id, appKeyId: appKey.id, customerId: customer.id, serviceId, tariffId,
    tariffSource: 'ORGANISATION', tariffAssignmentId: assignment.id, ...scope,
    actorJti: 'tariff-retirement-jti', requestedByUserId: input.ownerId,
    successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64),
    stripeCheckoutSessionId: 'cs_tariff_retirement', status: 'complete',
    leaseExpiresAt: new Date('2030-07-21T12:10:00.000Z'), expiresAt: new Date('2030-07-21T12:30:00.000Z'),
    completedAt: new Date('2030-07-21T12:00:00.000Z') } });
  return prisma.billingStripeSubscription.create({ data: {
    accountId: account.id, checkoutId: checkout.id, customerId: customer.id, serviceId, tariffId,
    tariffSource: 'ORGANISATION', tariffAssignmentId: assignment.id, ...scope,
    stripeSubscriptionId: 'sub_tariff_retirement', stripeMonthlyItemId: 'si_retire_monthly',
    stripeUsageItemId: 'si_retire_usage', status: 'active', livemode: false } });
}
