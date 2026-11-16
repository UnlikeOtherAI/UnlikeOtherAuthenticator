/** Synthetic billing products; no production account or payment provider is contacted. */
const now = '2026-10-03T12:00:00.000Z';

function nextUtcMonth(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
}

type Terms = {
  id: string; key: string; version: number; name: string;
  mode: 'standard' | 'free' | 'at_cost' | 'custom';
  collection: 'stripe' | 'manual' | 'none'; markupBps: number;
  usage: 'pay_as_you_go' | 'prepaid'; amountMinor: string;
  basis: 'flat' | 'per_seat'; isDefault?: boolean; retiredAt?: string | null;
  blockedBy?: string[]; createdBy?: string | null; createdAt?: string;
};

function tariff(terms: Terms) {
  return {
    id: terms.id, service_id: 'billing-1', key: terms.key, version: terms.version,
    name: terms.name, mode: terms.mode, collection_mode: terms.collection,
    markup_bps: terms.markupBps, markup_percent: (terms.markupBps / 100).toFixed(2),
    usage_payment_mode: terms.usage, usage_currency: 'USD',
    monthly_subscription: {
      amount_minor: terms.amountMinor, currency: 'USD', charge_basis: terms.basis,
      seat_policy: terms.basis === 'per_seat' ? 'automatic' : null,
      seat_charge_timing: terms.basis === 'per_seat' ? 'prorated' : null,
    },
    is_default: terms.isDefault ?? false,
    retired_at: terms.retiredAt ?? null,
    retire_blocked_by: terms.blockedBy ?? [],
    created_by_email: terms.createdBy === undefined ? 'operator@example.test' : terms.createdBy,
    created_at: terms.createdAt ?? now,
  };
}

export type FixtureTariff = ReturnType<typeof tariff>;

/**
 * One populated product: a default, an assigned (blocked) tariff, a contract-blocked tariff, a
 * retireable tariff and a retired version; assignments in effect, starting next month and
 * without history; active, revoked and expired app keys.
 */
export function createBillingServiceFixtures() {
  const tariffs = [
    tariff({ id: 'tariff-standard-2', key: 'standard', version: 2, name: 'Standard',
      mode: 'standard', collection: 'stripe', markupBps: 3000, usage: 'prepaid',
      amountMinor: '399', basis: 'per_seat', isDefault: true, blockedBy: ['default'],
      createdBy: 'system:seed' }),
    tariff({ id: 'tariff-free-1', key: 'free', version: 1, name: 'Free', mode: 'free',
      collection: 'none', markupBps: 0, usage: 'prepaid', amountMinor: '0', basis: 'flat',
      blockedBy: ['assignments'] }),
    tariff({ id: 'tariff-enterprise-1', key: 'enterprise', version: 1, name: 'Enterprise',
      mode: 'at_cost', collection: 'manual', markupBps: 0, usage: 'pay_as_you_go',
      amountMinor: '50000', basis: 'flat', blockedBy: ['contract_terms'] }),
    tariff({ id: 'tariff-team-1', key: 'team', version: 1, name: 'Team', mode: 'standard',
      collection: 'stripe', markupBps: 2000, usage: 'pay_as_you_go', amountMinor: '1500',
      basis: 'flat' }),
    tariff({ id: 'tariff-standard-1', key: 'standard', version: 1, name: 'Standard',
      mode: 'standard', collection: 'stripe', markupBps: 4000, usage: 'prepaid',
      amountMinor: '299', basis: 'per_seat', retiredAt: '2026-09-01T08:00:00.000Z',
      createdAt: '2026-01-10T09:00:00.000Z' }),
  ];
  const free = tariffs[1];
  if (!free) throw new Error('Free fixture tariff missing');
  const assignment = (id: string, organisation: { id: string; name: string },
    team: { id: string; name: string } | null, month: string | null) => ({
    id, tariff_id: free.id, scope: team ? 'team' as const : 'organisation' as const,
    organisation, team, tariff: free, effective_from_month: month,
    created_by_email: 'operator@example.test', created_at: now, updated_at: now,
  });
  const acme = { id: 'o1', name: 'Acme Engineering' };
  const assignments = [
    assignment('assignment-acme', acme, null, '2026-10'),
    assignment('assignment-backend', acme, { id: 't12', name: 'Backend' }, nextUtcMonth()),
    assignment('assignment-design', { id: 'o2', name: 'Acme Design' }, null, null),
  ];
  const appKey = (id: string, name: string, extra: Record<string, string | null>) => ({
    id, service_id: 'billing-1', purpose: 'customer_lifecycle' as const, name,
    key_prefix: `uoa_app_${id.slice(0, 4)}…`, actor_issuer: 'https://api.fixture.example',
    actor_audience: 'https://authentication.example/billing/v1/effective-tariff',
    actor_key_id: `${id}-2026`, checkout_return_origins: ['https://app.fixture.example'],
    last_used_at: null, expires_at: null, revoked_at: null,
    created_by_email: 'operator@example.test', created_at: now, ...extra,
  });
  const appKeys = [
    appKey('live', 'Fixture production', { last_used_at: now }),
    appKey('gone', 'Fixture staging', { revoked_at: '2026-09-20T10:00:00.000Z' }),
    appKey('aged', 'Fixture preview', { expires_at: '2026-08-31T23:59:59.000Z' }),
  ];
  const subscription = {
    id: 'subscription-1', account_id: 'stripe-account-row', stripe_account_id: 'acct_fixture',
    checkout_id: 'checkout-1', tariff_id: 'tariff-standard-2', tariff_source: 'service_default' as const,
    tariff_assignment_id: null, scope: 'team' as const, scope_key: 'o1:t13',
    organisation: acme, team: { id: 't13', name: 'Frontend' },
    stripe_subscription_id: 'sub_fixture', stripe_monthly_item_id: 'si_monthly',
    stripe_usage_item_id: 'si_usage', status: 'past_due', cancel_at_period_end: true,
    current_period_start: '2026-10-01T00:00:00.000Z', current_period_end: '2026-11-01T00:00:00.000Z',
    livemode: false, created_at: now, updated_at: now,
  };
  const product = {
    id: 'billing-1', name: 'Fixture product', identifier: 'fixture', active: true,
    tariffs, assignments, app_keys: appKeys, adjustments: [], stripe_catalogs: [],
    stripe_subscriptions: [subscription], created_at: now, updated_at: now,
  };
  const archived = {
    id: 'billing-2', name: 'Archived product', identifier: 'archived', active: false,
    tariffs: [tariff({ id: 'tariff-archived-1', key: 'standard', version: 1, name: 'Archived standard',
      mode: 'standard', collection: 'none', markupBps: 3000, usage: 'prepaid', amountMinor: '0',
      basis: 'flat', isDefault: true, blockedBy: ['default'] })].map((entry) => ({
      ...entry, service_id: 'billing-2' })),
    assignments: [], app_keys: [], adjustments: [], stripe_catalogs: [], stripe_subscriptions: [],
    created_at: now, updated_at: now,
  };
  const ledgerKeys = [
    { id: 'ledger-live', product: 'fixture', key_prefix: 'uoa_ledger_live',
      ledger_audience: 'https://ledger.fixture.example', source_domain: 'api.fixture.example',
      created_at: now, revoked_at: null },
    { id: 'ledger-gone', product: 'fixture', key_prefix: 'uoa_ledger_gone',
      ledger_audience: 'https://ledger.fixture.example', source_domain: 'old.fixture.example',
      created_at: '2026-08-01T12:00:00.000Z', revoked_at: '2026-09-01T12:00:00.000Z' },
  ];
  const tariffWrites: string[] = [];

  /** Retire/restore exactly as the API contract states; anything else is not handled here. */
  function handleTariffWrite(method: string, path: string) {
    const match = /^\/billing\/services\/billing-1\/tariffs\/([^/]+)\/(retire|restore)$/.exec(path);
    if (method !== 'POST' || !match) return null;
    const target = tariffs.find((entry) => entry.id === match[1]);
    if (!target) return { status: 404, body: { error: 'BILLING_TARIFF_NOT_FOUND' } };
    tariffWrites.push(`${match[2]} ${target.id}`);
    if (match[2] === 'retire') {
      if (target.retire_blocked_by.length) return { status: 409, body: { error: 'BILLING_TARIFF_IN_USE' } };
      target.retired_at ??= new Date().toISOString();
    } else target.retired_at = null;
    return { status: 200, body: target };
  }

  return { services: [product, archived], ledgerKeys, tariffWrites, handleTariffWrite };
}
