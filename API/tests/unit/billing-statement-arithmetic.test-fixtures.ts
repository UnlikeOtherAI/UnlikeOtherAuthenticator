import { BillingAppKeyPurpose } from '@prisma/client';
import type { NormalizedMeteringUsage } from '../../src/services/billing-metering.types.js';

export const now = new Date('2026-07-20T12:00:00.000Z');
export const credential = {
  id: 'app_key_deepwater_lifecycle',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://api.deepwater.example',
  actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/customer-statement',
  actorKeyId: 'deepwater_actor_1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.deepwater.example'],
  service: { id: 'service_deepwater', identifier: 'deepwater', name: 'DeepWater' },
};
export const request = {
  product: 'deepwater',
  organisationId: 'org_1',
  teamId: 'team_1',
  userId: 'user_1',
};
export const summary = {
  product: { id: 'service_deepwater', identifier: 'deepwater' },
  subject: {
    user_id: 'user_1',
    organisation_id: 'org_1',
    team_id: 'team_1',
  },
  tariff: {
    id: 'tariff_standard_v4',
    key: 'standard',
    version: 4,
    mode: 'standard' as const,
    collection_mode: 'stripe' as const,
    markup_bps: 2_000,
    markup_percent: '20.00',
    usage_price_multiplier_bps: 12_000,
    monthly_subscription: { amount_minor: '2000', currency: 'GBP' },
    usage_billing_enabled: true,
    payment_collection_enabled: true,
    raw_usage_preserved: true as const,
  },
  assignment: { scope: 'team' as const, id: 'assignment_1' },
  stripe_collection_enabled: true,
  stripe_mode: 'test' as const,
  can_manage: true,
  subscription: {
    id: 'subscription_1',
    status: 'active',
    scope: 'team',
    scope_key: 'org_1:team_1',
    tariff_id: 'tariff_standard_v4',
    cancel_at_period_end: false,
    current_period_start: '2026-07-01T00:00:00.000Z',
    current_period_end: '2026-08-01T00:00:00.000Z',
    billing_phase: 'calendar_month',
    created_at: '2026-07-01T00:00:00.000Z',
    synced_at: now.toISOString(),
  },
};
export const effectiveTerm = {
  tariffId: 'tariff_standard_v4', assignmentId: 'assignment_1',
  tariff: {
    id: 'tariff_standard_v4', serviceId: 'service_deepwater', key: 'standard',
    version: 4, name: 'Provider cost plus 20% markup', mode: 'STANDARD', collectionMode: 'STRIPE',
    markupBps: 2_000, monthlyAmountMinor: 2000n, currency: 'GBP',
    monthlyChargeBasis: 'FLAT', seatPolicy: null, seatChargeTiming: null,
    usagePaymentMode: 'PAY_AS_YOU_GO',
  },
};

export function metering(groupBy: 'service' | 'user'): NormalizedMeteringUsage {
  const shared = {
    schemaVersion: 1 as const,
    product: 'deepwater',
    groupBy,
    scope: {
      organizationId: 'org_1',
      teamId: 'team_1',
      userId: null,
      month: '2026-07',
      startsAt: '2026-07-01T00:00:00.000Z',
      endsAt: '2026-08-01T00:00:00.000Z',
    },
    calls: '2',
    snapshot: {
      cursor:
        groupBy === 'service'
          ? 'mus_0123456789ABCDEFGHIJKLMNOPQRSTUV'
          : 'mus_1123456789ABCDEFGHIJKLMNOPQRSTUV',
      id:
        groupBy === 'service'
          ? 'mus_0123456789ABCDEFGHIJKLMNOPQRSTUV'
          : 'mus_1123456789ABCDEFGHIJKLMNOPQRSTUV',
      capturedAt: '2026-07-20T11:59:00.000Z',
      immutable: true as const,
      sha256: groupBy === 'service' ? 'a'.repeat(64) : 'b'.repeat(64),
    },
  };
  if (groupBy === 'service') {
    return {
      ...shared,
      lines: [
        {
          serviceId: 'openai',
          usageUnit: 'tokens',
          calls: '2',
          inputUnits: '100',
          cachedInputUnits: '0',
          outputUnits: '50',
          estimatedProviderCost: null,
          actualProviderCost: '2',
          selectedProviderCost: '2',
          currency: 'USD',
          costProvenance: 'provider_invoice',
          billingDisposition: 'paid',
          billingProduct: 'deepwater',
          callerProduct: 'nessie',
          originProduct: 'deepsignal',
          userId: null,
        },
        {
          serviceId: 'serp',
          usageUnit: 'requests',
          calls: '1',
          inputUnits: '10',
          cachedInputUnits: '0',
          outputUnits: '0',
          estimatedProviderCost: '1',
          actualProviderCost: null,
          selectedProviderCost: '1',
          currency: 'USD',
          costProvenance: 'provider_pricebook',
          billingDisposition: 'paid',
          billingProduct: 'deepwater',
          callerProduct: 'deepwater',
          originProduct: 'nessie',
          userId: null,
        },
      ],
    };
  }
  return {
    ...shared,
    lines: [
      {
        serviceId: 'openai',
        usageUnit: 'tokens',
        calls: '1',
        inputUnits: '40',
        cachedInputUnits: '0',
        outputUnits: '20',
        estimatedProviderCost: '1',
        actualProviderCost: null,
        selectedProviderCost: '1',
        currency: 'USD',
        costProvenance: 'provider_pricebook',
        billingDisposition: 'paid',
        billingProduct: 'deepwater',
        callerProduct: 'nessie',
        originProduct: 'nessie',
        userId: 'user_1',
      },
      {
        serviceId: 'openai',
        usageUnit: 'tokens',
        calls: '1',
        inputUnits: '60',
        cachedInputUnits: '0',
        outputUnits: '30',
        estimatedProviderCost: null,
        actualProviderCost: '1',
        selectedProviderCost: '1',
        currency: 'USD',
        costProvenance: 'provider_invoice',
        billingDisposition: 'paid',
        billingProduct: 'deepwater',
        callerProduct: 'nessie',
        originProduct: 'nessie',
        userId: 'user_2',
      },
    ],
  };
}
