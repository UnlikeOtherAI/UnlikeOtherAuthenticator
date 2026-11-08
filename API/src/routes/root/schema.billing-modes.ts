import type { EndpointSchema } from './schema.js';
const path='/internal/admin/billing/organisations/:orgId/mode';
const auth='Current ADMIN_AUTH_DOMAIN SUPERUSER bearer; writes recheck current identity, role and epoch under locks.';
export const billingModeEndpoints:EndpointSchema[]=[
  {method:'GET',path,auth,description:'Read the active organisation financial mode, immutable scope epoch and quiescence blockers.',
    response:{organisation_id:'exact organisation',mode:'live default | sandbox',revision:'0 for untouched LIVE; monotonic operator revision',epoch:'immutable organisation cutover instant',blockers:'current code/count pairs across the whole organisation'},
    notes:'UOA Admin Organisations > selected organisation > Billing owns the setting for current/future teams across products. No team allowlist, customer mode picker or automatic adoption.'},
  {method:'PUT',path,auth,description:'Change a quiescent organisation mode with atomic operator audit and stale-edit refusal.',
    body:{mode:'live | sandbox',expected_revision:'required displayed nonnegative integer'},
    response:{mode:'committed mode',revision:'new revision; no-op retains revision',epoch:'unchanged immutable cutover',blockers:'current blockers'},
    notes:'409 BILLING_ORGANISATION_MODE_CHANGED for stale edits;409 BILLING_ORGANISATION_MODE_BLOCKED for financial balances/consents/subscriptions/payments/provider work/month usage. No financial records move. Inclusive change month remains held. Old displayed new-work contexts become stale.'},
  ...['GET','PUT'].map(method=>({method,path:'/internal/admin/billing/organisations/:orgId/teams/:teamId/mode',auth,
    description:method==='GET'?'Legacy active-team doorway to controlling organisation mode.':'Retired team mode mutation; always refuses409 BILLING_ORGANISATION_MODE_REQUIRED.',
    notes:'The organisation owns the setting. Legacy team policies remain immutable historical evidence.'})),
];
