import type { EndpointSchema } from './schema.js';

export const automaticMembershipEndpoints: EndpointSchema[] = [
  { method: 'POST', path: '/org/automatic-membership/attestations', description: 'Attest a UOA subject has a currently verified exact email domain.', auth: 'Dedicated automatic-membership app key for the Nessie service only', body: { uoaSub: 'UOA stable subject', domain: 'exact ASCII domain' }, response: { '200': 'short-lived UOA attestation', '204': 'no current verified matching identity' } },
  { method: 'GET', path: '/org/automatic-membership/organisations/:orgId/teams', description: 'List UOA-owned team targets after direct Nessie service-access scope check.', auth: 'Dedicated automatic-membership app key' },
  { method: 'POST', path: '/org/automatic-membership/organisations/:orgId/authorizations', description: 'Recheck a requester is an organisation owner/admin or administrator of every named team.', auth: 'Dedicated automatic-membership app key' },
  { method: 'GET', path: '/org/automatic-membership/organisations/:orgId/subjects', description: 'Cursor-page stable UOA subjects with a currently verified exact matching email; no email is returned.', auth: 'Dedicated automatic-membership app key', query: { domain: 'exact ASCII domain', cursor: 'opaque cursor', limit: '1-100' } },
  { method: 'POST', path: '/org/automatic-membership/organisations/:orgId/teams/:teamId/grants', description: 'Idempotently grant only normal organisation/team member access. Existing stronger roles are retained.', auth: 'Dedicated automatic-membership app key', body: { subject: 'UOA stable subject', idempotency_key: 'caller idempotency key', rule_generation: 'positive generation fence', fence_token: 'short-lived Nessie fence' } },
];
