import { BillingAppKeyPurpose, BillingCollectionMode, BillingTariffMode } from '@prisma/client';

export const now = new Date('2026-07-19T12:00:00.000Z');
export const account = {
  id: 'stripe_account_row_test',
  stripeAccountId: 'acct_uoa',
  livemode: false,
  createdAt: now,
  updatedAt: now,
};
export const tariff = {
  id: 'tariff_1',
  serviceId: 'service_1',
  key: 'standard',
  version: 2,
  name: 'Standard',
  mode: BillingTariffMode.STANDARD,
  collectionMode: BillingCollectionMode.STRIPE,
  markupBps: 2000,
  monthlyAmountMinor: 2000n,
  currency: 'GBP',
  isDefault: true,
  createdByUserId: 'admin_1',
  createdByEmail: 'admin@example.com',
  createdAt: now,
};
export const payload = {
  schema_version: 1 as const,
  snapshot_id: 'snapshot_1',
  product: { id: 'service_1', identifier: 'deepwater' },
  authorized_party: { app_key_id: 'app_key_1' },
  subject: {
    user_id: 'user_1',
    organisation_id: 'org_1',
    team_id: 'team_1',
  },
  tariff: {
    id: 'tariff_1',
    key: 'standard',
    version: 2,
    mode: 'standard' as const,
    collection_mode: 'stripe' as const,
    markup_bps: 2000,
    markup_percent: '20.00',
    usage_price_multiplier_bps: 12000,
    monthly_subscription: { amount_minor: '2000', currency: 'GBP' },
    usage_billing_enabled: true,
    payment_collection_enabled: true,
    raw_usage_preserved: true as const,
  },
  assignment: { scope: 'service_default' as const, id: null },
  issued_at: now.toISOString(),
  expires_at: new Date(now.getTime() + 300_000).toISOString(),
};
export const credential = {
  id: 'app_key_1',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://ledger.example.com',
  actorAudience: 'https://auth.example.com/billing/v1/effective-tariff',
  actorKeyId: 'key_1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.nessie.works'],
  service: { id: 'service_1', identifier: 'deepwater', name: 'DeepWater' },
};
export const request = {
  product: 'deepwater',
  organisationId: 'org_1',
  teamId: 'team_1',
  userId: 'user_1',
  successUrl: 'https://app.nessie.works/billing/success',
  cancelUrl: 'https://app.nessie.works/billing/cancel',
};
