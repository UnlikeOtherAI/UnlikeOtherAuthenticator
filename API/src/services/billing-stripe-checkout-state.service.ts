import {
  BillingAssignmentScope,
  BillingTariffSource,
  type BillingStripeCheckoutSession,
  type BillingStripeCustomer,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import type { EffectiveTariffPayload } from './billing-entitlement.service.js';
import {
  assertStripeObjectLivemode,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';

export type StripeCheckoutClient = Pick<
  Stripe,
  'accounts' | 'billing' | 'checkout' | 'customers' | 'prices' | 'products'
>;

export function billingScope(payload: EffectiveTariffPayload): {
  scope: BillingAssignmentScope;
  scopeKey: string;
  teamId: string | null;
} {
  if (payload.assignment.scope === 'team') {
    return {
      scope: BillingAssignmentScope.TEAM,
      scopeKey: `${payload.subject.organisation_id}:${payload.subject.team_id}`,
      teamId: payload.subject.team_id,
    };
  }
  return {
    scope: BillingAssignmentScope.ORGANISATION,
    scopeKey: payload.subject.organisation_id,
    teamId: null,
  };
}

export function tariffSource(payload: EffectiveTariffPayload): BillingTariffSource {
  const sources = {
    service_default: BillingTariffSource.SERVICE_DEFAULT,
    organisation: BillingTariffSource.ORGANISATION,
    team: BillingTariffSource.TEAM,
  } as const;
  return sources[payload.assignment.scope];
}

export function overlappingSubscriptionScope(
  accountId: string,
  serviceId: string,
  orgId: string,
  scope: BillingAssignmentScope,
  scopeKey: string,
): Prisma.BillingStripeSubscriptionWhereInput {
  return {
    accountId,
    serviceId,
    orgId,
    status: { notIn: ['canceled', 'incomplete_expired'] },
    ...(scope === BillingAssignmentScope.ORGANISATION
      ? {}
      : {
          OR: [
            { scope: BillingAssignmentScope.ORGANISATION },
            { scope: BillingAssignmentScope.TEAM, scopeKey },
          ],
        }),
  };
}

export function overlappingCheckoutScope(
  accountId: string,
  serviceId: string,
  orgId: string,
  scope: BillingAssignmentScope,
  scopeKey: string,
): Prisma.BillingStripeCheckoutSessionWhereInput {
  return {
    accountId,
    serviceId,
    orgId,
    status: { in: ['creating', 'open'] },
    ...(scope === BillingAssignmentScope.ORGANISATION
      ? {}
      : {
          OR: [
            { scope: BillingAssignmentScope.ORGANISATION },
            { scope: BillingAssignmentScope.TEAM, scopeKey },
          ],
        }),
  };
}

export function assertCheckoutBinding(
  checkout: BillingStripeCheckoutSession,
  expected: {
    account: StripeAccountContext;
    credential: VerifiedBillingAppKey;
    customerId: string;
    payload: EffectiveTariffPayload;
    scope: ReturnType<typeof billingScope>;
    successUrlDigest: string;
    cancelUrlDigest: string;
  },
): void {
  if (
    checkout.accountId !== expected.account.id ||
    checkout.appKeyId !== expected.credential.id ||
    checkout.customerId !== expected.customerId ||
    checkout.serviceId !== expected.credential.service.id ||
    checkout.tariffId !== expected.payload.tariff.id ||
    checkout.tariffSource !== tariffSource(expected.payload) ||
    checkout.tariffAssignmentId !== expected.payload.assignment.id ||
    checkout.orgId !== expected.payload.subject.organisation_id ||
    checkout.teamId !== expected.scope.teamId ||
    checkout.scope !== expected.scope.scope ||
    checkout.scopeKey !== expected.scope.scopeKey ||
    checkout.successUrlDigest !== expected.successUrlDigest ||
    checkout.cancelUrlDigest !== expected.cancelUrlDigest
  ) {
    throw new AppError('BAD_REQUEST', 409, 'STRIPE_CHECKOUT_SCOPE_CONFLICT');
  }
}

export async function ensureStripeCustomer(
  params: {
    customer: BillingStripeCustomer;
    account: StripeAccountContext;
    email: string;
    name: string;
    orgId: string;
    teamId: string | null;
    scope: BillingAssignmentScope;
    scopeKey: string;
  },
  deps: { prisma: PrismaClient; stripe: StripeCheckoutClient },
): Promise<BillingStripeCustomer> {
  const metadata = {
    uoa_scope: params.scope.toLowerCase(),
    uoa_scope_key: params.scopeKey,
    uoa_organisation_id: params.orgId,
    uoa_stripe_account_id: params.account.stripeAccountId,
    uoa_stripe_mode: params.account.livemode ? 'live' : 'test',
    ...(params.teamId ? { uoa_team_id: params.teamId } : {}),
  };
  if (params.customer.stripeCustomerId) {
    const remote = await deps.stripe.customers.retrieve(params.customer.stripeCustomerId);
    if (
      'deleted' in remote ||
      remote.id !== params.customer.stripeCustomerId ||
      Object.entries(metadata).some(([key, value]) => remote.metadata[key] !== value)
    ) {
      throw new AppError('INTERNAL', 502, 'STRIPE_CUSTOMER_BINDING_INVALID');
    }
    assertStripeObjectLivemode(remote, params.account.livemode);
    return params.customer;
  }

  const remote = await deps.stripe.customers.create(
    { email: params.email, name: params.name, metadata },
    {
      idempotencyKey: [
        'uoa',
        params.account.stripeAccountId,
        params.account.livemode ? 'live' : 'test',
        'customer',
        params.customer.id,
      ].join(':'),
    },
  );
  assertStripeObjectLivemode(remote, params.account.livemode);
  return deps.prisma.billingStripeCustomer.update({
    where: { id: params.customer.id },
    data: { stripeCustomerId: remote.id },
  });
}
