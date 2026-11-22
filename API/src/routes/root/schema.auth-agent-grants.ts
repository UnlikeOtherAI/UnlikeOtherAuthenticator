import type { EndpointSchema } from './schema.js';

const auth = 'verified config_url and the calling product’s existing domain-hash bearer';

export const agentConnectionGrantEndpoints: EndpointSchema[] = [
  {
    method: 'POST', path: '/auth/agent-grants',
    description: 'Create or recover the grant for one program a person connected to the product, in one organisation team.',
    auth, query: { config_url: 'signed app config whose domain matches the authenticated bearer' },
    body: {
      request_id: 'UUID the product generates once per (connection, team) before issue; exact retries recover the same grant.',
      connection_id: 'The product’s own id for the connected program, 1–160 of [A-Za-z0-9._:-].',
      product: 'nessie (first-party, on by default at api.nessie.works), or the product of an enabled confidential delegation mapping that lists agent.connection.',
      resource: 'https://api.nessie.works/mcp for Nessie, or the exact resource of that mapping (the product’s own API).',
      subject_token: 'Fresh source-config RS256 assertion, aud=PUBLIC_BASE_URL+/auth/agent-grants, with active org/team, sub/tv/jti and the person’s live assurance_ref for that exact team.',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    },
    response: {
      grant_handle: 'Opaque UUID; useful only with the same authenticated product domain credential and request_id.',
      idle_expires_at: 'RFC3339; 90 days after issue, slid only by renewals with touch=true.',
      expires_at: 'RFC3339; the earlier of idle_expires_at and the organisation’s agent_connection_max_days ceiling.',
      '[status]': '201 first commit; 200 exact response-loss recovery.',
    },
    notes: 'Requires a live, unexpired independent or SSO session proof for the exact organisation and team; recovery proofs are refused. The proof’s method, SSO connection revision/generation, external identity, MFA source, AMR and SSO policy generation are copied so renewals can recheck them after the session ends. agent.connection is never mintable through /auth/token.',
  },
  {
    method: 'POST', path: '/auth/agent-grants/:grantHandle/renew',
    description: 'Recheck a connected program’s grant and return the person’s current organisation context, optionally with a short resource token.',
    auth, query: { config_url: 'same signed app config and domain credential used to issue the grant' },
    body: {
      request_id: 'original grant request UUID',
      touch: 'boolean; true only when the connected program itself is presenting its credential. At most once an hour it moves idle_expires_at to now+90 days. Reconciliation, revocation intake and background work send false.',
      'resource?': 'with scope: an exact resource the product’s mapping allows for a downstream token',
      'scope?': 'with resource: space-delimited subset of ai.invoke, billing.read, memory.read, memory.write',
    },
    response: {
      idle_expires_at: 'RFC3339', expires_at: 'RFC3339, including the organisation ceiling',
      org: 'org context for the grant’s organisation: org_id, tenant_slug, org_role, teams, team_roles',
      'access_token?': 'with resource/scope: RS256 resource token, max 120 seconds, carrying agent_connection {grant_handle, connection_id}; never an assurance_id',
    },
    notes: 'Every renewal rechecks revocation, idle and organisation expiry, the credential epoch (password reset, 2FA change, logout anywhere end it), the product mapping, active user and source-domain role, active organisation and team membership, unpaid seats, the SSO policy generation, and for SSO grants the connection, external identity and enterprise provisioning. Generic 403 AGENT_GRANT_UNAVAILABLE on any failure. A grant never satisfies a session proof, account control, step-up, session brokering, token provisioning or another grant’s issue.',
  },
  {
    method: 'POST', path: '/auth/agent-grants/:grantHandle/revoke',
    description: 'Revoke one connected program’s grant; repeats are idempotent.',
    auth, query: { config_url: 'same signed app config and domain credential used to issue the grant' },
    body: { request_id: 'original grant request UUID' },
    response: { revoked: 'true' },
    notes: 'Serializes with renew and needs no current membership, so a product can always end what it holds.',
  },
];
