import { billingCreditsV1ConformanceFixture } from './credits-conformance-fixture.js';
import { billingStatementV1ConformanceFixture } from './conformance-fixture.js';
import type { BillingCreditsManagerV1 } from './credits-types.js';
import type { BillingOrganisationCapabilitiesV1, BillingOrganisationOverviewV1 } from './organisation-overview-types.js';

const credits = billingCreditsV1ConformanceFixture as BillingCreditsManagerV1;
const statement = billingStatementV1ConformanceFixture;
const balance = { credits: credits.credit_balance.credits, display: credits.credit_balance.display,
  usd_equivalent: credits.credit_balance.usd_equivalent };
const subject = { product: 'deepwater', organisation_id: 'org_example', team_id: 'team_example', user_id: 'user_example' };
const scope = { kind: 'organisation' as const, organisation_id: subject.organisation_id,
  mode: 'live' as const, revision: 0, epoch: '2026-11-07T22:00:00.000Z' };
export const billingOrganisationCapabilitiesV1ConformanceFixture: BillingOrganisationCapabilitiesV1 = {
  schema_version: 1, generated_at: '2026-11-07T22:00:01.000Z', subject, financial_scope: scope,
  capabilities: { can_view_billing: true, can_manage_billing: true },
};
export const billingOrganisationOverviewV1ConformanceFixture: BillingOrganisationOverviewV1 = {
  schema_version: 1, generated_at: '2026-11-07T22:00:01.000Z', subject, financial_scope: scope,
  sections: {
    accrued_bill: { state: 'pending_reconciliation', code: 'BILLING_MODE_TRANSITION_RECONCILIATION_REQUIRED',
      message: 'This month’s bill is pending reconciliation. Confirmed credits and payment controls remain available.' },
    credits: { state: 'confirmed', message: 'Confirmed organisation credits.', data: {
      credit_account_id: 'organisation_wallet', confirmed_balance: balance,
      reserved_credits: { credits: '0', display: '0 credits', usd_equivalent: { amount: '0', currency: 'USD', display: '$0.00' } },
      spendable_balance: balance, as_of: '2026-11-07T22:00:01.000Z',
      billing_status: { settlement_state: 'pending_reconciliation', message: 'Unconfirmed usage is pending reconciliation.' },
    } },
    funding: { state: 'confirmed', message: 'Organisation funding controls.', data: {
      capabilities: credits.capabilities, funding_policy: credits.funding_policy,
      automatic_top_up: credits.automatic_top_up, conversion: credits.conversion,
      collection: { stripe_collection_enabled: true, stripe_mode: 'live' },
    } },
    subscription: { state: 'confirmed', message: 'Organisation plan and subscription controls.', data: {
      plan: statement.plan, collection: { ...statement.collection, stripe_mode: 'live' },
      subscription: null, capabilities: statement.capabilities, actions: statement.actions,
    } },
    history: { state: 'confirmed', message: 'Organisation billing history.', data: {
      cycles_request: { method: 'POST', path: '/billing/v1/cycles/list', body: {...subject,financial_scope:'organisation',billing_mode:'live'} },
      invoices_request: { method: 'POST', path: '/billing/v1/invoices/list', body: { ...subject,financial_scope:'organisation',billing_mode:'live',charge_month: '2026-11' } },
    } },
  },
};
