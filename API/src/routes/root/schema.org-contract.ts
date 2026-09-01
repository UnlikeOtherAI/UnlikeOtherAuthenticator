import { IDENTITY_AVATAR_URL_NOTE } from './schema.avatars.js';
import type { EndpointSchema } from './schema.js';

// Every /org/* endpoint takes the domain query and is gated by the org feature flag, so the
// machine schema must advertise that uniformly rather than per-endpoint (issue #7 — integrators
// were blocked because `domain` and the X-UOA-Access-Token requirement were undocumented).
const ORG_DOMAIN_QUERY: Record<string, string> = {
  domain: 'string (required) — must match the config domain for domain-hash auth',
  config_url: 'string (required)',
};

const ORG_CONTRACT_NOTE =
  'Requires org_features.enabled=true (otherwise 404). Two calling modes. ' +
  'USER MODE: send X-UOA-Access-Token — the acting user is its `userId` claim, a new ' +
  'organisation is owned by that user (the body must not carry owner_user_id), and ' +
  'non-superusers can only create one when org_features.allow_user_create_org=true, else 403 ' +
  'ORG_CREATION_NOT_ALLOWED. In user mode an :orgId is resolved by ID ALONE: one organisation is ' +
  'usable from every UOA-integrated product, so the product that created it (organisations.domain, ' +
  'the origin domain) does not decide who may read or manage it. The gates are the token domain ' +
  'matching ?domain= (else 403 ACCESS_TOKEN_DOMAIN_MISMATCH), the token org claim matching :orgId ' +
  '(else 403 INSUFFICIENT_ORG_ROLE), and live ACTIVE membership/capability in the org. ' +
  'organisations.domain still owns the slug namespace, backend-mode ownership, and invite email ' +
  'identity. BACKEND MODE: omit ' +
  'X-UOA-Access-Token entirely — the domain ' +
  'pairing already on every /org route (domain-hash bearer + verified signed config + ?domain=) ' +
  'authorises the call, and there is no acting user, so per-user org/team role checks do not ' +
  'apply. Backend mode requires org_features.backend_org_management=true in the signed config; ' +
  'without it a missing token is still 401 MISSING_ACCESS_TOKEN. Backend mode never crosses ' +
  'domains: the call binds to the VERIFIED config domain (a differing ?domain= is 400 ' +
  'DOMAIN_MISMATCH) and an :orgId whose ORIGIN domain is not the verified one is 404 — backend ' +
  'mode is the one place that scoping still applies, because it has no acting user and therefore ' +
  'no membership to gate on. Where a route needs to ' +
  'name a user it takes one explicitly (owner_user_id on POST /org/organisations, userId on the ' +
  'member routes). GET /org/me and POST /org/organisations/:orgId/teams/:teamId/join are about ' +
  'the acting user and stay user-mode only (401 without a token). Backend-mode mutations are ' +
  'recorded in the org audit log with actor_user_id null and metadata.uoa_actor = ' +
  '{ via: "domain_backend", source_domain }. ' +
  'GET /org/organisations is BACKEND-ONLY: it lists a whole domain and has no user mode, so it ' +
  'refuses any present X-UOA-Access-Token with 401 ACCESS_TOKEN_NOT_ALLOWED (valid or blank ' +
  'alike) — omit the header, and use GET /org/me for a user\'s own workspaces. ' +
  IDENTITY_AVATAR_URL_NOTE;

export function withOrgContract(list: EndpointSchema[]): EndpointSchema[] {
  return list.map((endpoint) => ({
    ...endpoint,
    query: { ...ORG_DOMAIN_QUERY, ...endpoint.query },
    notes: endpoint.notes ?? ORG_CONTRACT_NOTE,
  }));
}
