import type { EndpointSchema } from './schema.js';
const path = '/internal/admin/billing/organisations/:orgId/teams/:teamId/mode';
const auth = 'Current ADMIN_AUTH_DOMAIN SUPERUSER bearer; mutation rechecks active identity, role and credential epoch under authority locks.';
export const billingModeEndpoints: EndpointSchema[] = [
  { method: 'GET', path, auth, description: 'Read the exact active team’s durable platform billing mode and change blockers.',
    response: { organisation_id: 'exact owning organisation', team_id: 'exact active team',
      mode: 'live (default) | sandbox', revision: 'monotonic operator revision; untouched live is 0',
      adopting_sandbox_history: 'optional true: first explicit sandbox choice can preserve exclusively TEST history on the configured sandbox account',
      blockers: 'code/count pairs for funded balances, consents, payments, subscriptions, provider work and current-month usage' },
    notes: 'Private no-store. UOA Admin Teams > selected team > Billing owns this setting across products. Regular members cannot choose modes. Credentials are separate server configuration.' },
  { method: 'PUT', path, auth, description: 'Change a quiescent team’s billing mode, or explicitly adopt eligible existing TEST history, with an atomic administrator audit.',
    body: { mode: 'live | sandbox', expected_revision: 'required nonnegative integer from the displayed current state' },
    response: { mode: 'committed mode', revision: 'new revision; exact no-op keeps revision', blockers: 'current blockers' },
    notes: '409 BILLING_TEAM_MODE_CHANGED for stale edits; 409 BILLING_TEAM_MODE_BLOCKED for financial work or balances. The first explicit sandbox choice may preserve exclusively TEST history on the configured account, with eligibility rechecked under the organisation lock. Any scoped LIVE history, another account tuple, active organisation responsibility, current-month usage or unbound grant blocks this exception. No customer, subscription, historical object or money migration. Organisation money requires uniform active team modes. Mode changes invalidate previously displayed new-work contexts.' },
];
