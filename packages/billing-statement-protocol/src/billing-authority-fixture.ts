import { BILLING_TEAM_OVERVIEW_PATH, type BillingCapabilitiesV2, type BillingTeamOverviewV1 }
  from './billing-authority-types.js';

const subject = { product: 'nessie', organisation_id: 'org_example', team_id: 'team_example', user_id: 'user_example' };
const generated_at = '2026-11-08T12:00:00.000Z';
const common = { schema_version: 2 as const, generated_at, subject };
export const billingCapabilitiesV2ConformanceFixtures = {
  organisation_manager: { ...common, access: 'organisation_manager', financial_scope: {
    kind: 'organisation', organisation_id: subject.organisation_id, mode: 'live', revision: 0,
    epoch: '2026-11-08T00:00:00.000Z',
  } },
  team_reader: { ...common, access: 'team_reader', team_scope: {
    kind: 'team', product: subject.product, organisation_id: subject.organisation_id, team_id: subject.team_id,
  }, overview_request: { method: 'POST', path: BILLING_TEAM_OVERVIEW_PATH, body: subject } },
  none: { ...common, access: 'none' },
} satisfies Record<string, BillingCapabilitiesV2>;
const credit = (credits: string, amount: string, display: string) => ({
  credits, display: `${credits} credits`, usd_equivalent: { amount, currency: 'USD' as const, display },
});
export const billingTeamOverviewV1ConformanceFixture = {
  schema_version: 1, generated_at, subject,
  team_scope: { kind: 'team', product: subject.product,
    organisation_id: subject.organisation_id, team_id: subject.team_id },
  title: 'Team usage',
  description: 'Read-only records for this team. Organisation owners and admins manage organisation billing.',
  team: { id: subject.team_id, name: 'Example team' },
  product: { id: 'service_example', identifier: 'nessie', name: 'Nessie' },
  period: { month: '2026-11', starts_at: '2026-11-01T00:00:00.000Z', ends_at: '2026-12-01T00:00:00.000Z' },
  sections: {
    activity: { state: 'confirmed', message: 'Activity recorded for this team.', data: {
      as_of: generated_at, recorded_calls: { quantity: '12', display: '12', label: 'Recorded calls' },
    } },
    recorded_credit_usage: { state: 'confirmed', message: 'Recorded usage is shown by its original billing source.',
      data: { as_of: generated_at, sources: [{ source_ref: `tbs_${'a'.repeat(64)}`, mode: 'live', label: 'Live usage',
        recorded_usage: credit('100', '0.1', '$0.10'), waived_usage: credit('0', '0', '$0.00') }] } },
    retained_credits: { state: 'confirmed',
      message: 'Retained team credit records are history. New organisation wallets start fresh.', data: {
        as_of: generated_at, records: [{ record_id: 'legacy_team_wallet', source_ref: `tbs_${'b'.repeat(64)}`,
          mode: 'sandbox', label: 'Sandbox history', recorded_balance: credit('500', '0.5', '$0.50'),
          recorded_at: '2026-11-01T00:00:00.000Z' }],
      } },
  },
} satisfies BillingTeamOverviewV1;
