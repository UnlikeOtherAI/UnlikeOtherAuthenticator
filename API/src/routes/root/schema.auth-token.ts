import type { EndpointSchema } from './schema.js';

export const authTokenEndpoint: EndpointSchema = {
  method: 'POST',
  path: '/auth/token',
  description:
    'Exchange an authorization code or refresh token for the legacy access + refresh pair, explicitly move that pair to one exact authorized team, or exchange a source-signed JWT assertion / UOA-issued audience-bound access token for a resource-bound confidential access token. Authorization-code exchange re-resolves current exact-team 2FA policy and user enrollment and rejects a code lacking required interactive TOTP proof before token-family creation.',
  auth: 'config_url query param + domain hash bearer token',
  body: {
    'grant_type?':
      '"authorization_code" (default), "refresh_token", "urn:unlikeotherai:params:oauth:grant-type:team-switch", or "urn:ietf:params:oauth:grant-type:token-exchange"',
    'code?': 'authorization code (for authorization_code grant)',
    'redirect_url?': 'required for authorization_code grant; must match issued URL',
    'code_verifier?': 'required for authorization_code grant; must match the S256 challenge',
    'refresh_token?': 'refresh token (for refresh_token and team-switch grants)',
    'organization_id?':
      'exact target organisation id (required for team-switch grant; must be paired with team_id)',
    'team_id?':
      'exact target team id (required for team-switch grant; must belong to organization_id)',
    'subject_token?':
      'For a first hop: one-time RS256 JWT with exp-iat <= 60 seconds, signed by the source config JWKS. For a chained hop: UOA-issued RS256 at+jwt access token with aud exactly https://<authenticated caller config domain>, non-null org/active, and remaining lifetime.',
    'subject_token_type?':
      '"urn:ietf:params:oauth:token-type:jwt" for a first-hop assertion, or "urn:ietf:params:oauth:token-type:access_token" for a chained UOA token',
    'product?':
      'lowercase product identifier (required for token-exchange grant); must match the DB mapping bound to the authenticated app domain credential',
    'resource?':
      'exact DB-allowlisted HTTPS resource URI (required for token-exchange grant; becomes access-token aud)',
    'scope?':
      'space-delimited exact requested scopes (required for token-exchange grant); supported values are ai.invoke, billing.read, and token.provision, and every requested scope must be allowed by the product mapping',
  },
  response: {
    access_token:
      'Authorization-code/refresh/team-switch grants: legacy HS256 JWT with aud="uoa:access-token". Confidential token-exchange grant: at-most-5-minute RS256 JWT bound to resource, verifiable at GET /oauth/jwks.json, with product, exact requested scope, stable sub, validated provenance, and no domain bearer credential. A chained result never outlives its inbound token.',
    'access_token.active.tenantSlug?':
      'canonical organisation slug for the selected team and safe DNS tenant label. Team.slug is not a tenant DNS key because it is only unique within its organisation.',
    expires_in: 'number — seconds until access_token expiry',
    'refresh_token?':
      'string — opaque, server-side only; authorization-code/refresh/team-switch grants only, never hand to the browser',
    'refresh_token_expires_in?':
      'number — seconds until refresh_token expiry; authorization-code/refresh/team-switch grants only',
    'issued_token_type?':
      '"urn:ietf:params:oauth:token-type:access_token"; confidential token-exchange grant only',
    'scope?':
      'exact granted request subset of "ai.invoke", "billing.read", and/or "token.provision"; token.provision is never implied by ai.invoke; confidential token-exchange grant only',
    token_type: '"Bearer"',
    'firstLogin?':
      'object { memberships: { orgs, teams }, pending_invites, capabilities { can_create_org, can_accept_invite } } — included only on authorization_code exchange when org_features.enabled is true. Never included on refresh_token or team-switch grants.',
    '[note]':
      'There is NO top-level `user` field. User identity lives inside access_token claims (read claims.sub). Every immediate caller uses its own app credential and enabled DB mapping; no shared/cross-app/fallback key or webhook secret is accepted.',
    '[rate limit]':
      'Authorization-code, refresh, and team-switch grants: 10/min per IP, plus a service-wide global ceiling of 30,000/min per instance. Confidential exchange: 600/min per authenticated source domain plus 60/min per verified source-domain user.',
    '401 refresh policy':
      'If the domain signature policy changed and the refresh-token user is incomplete, or a stored scoped session no longer has its exact active product mapping plus ACTIVE org/team memberships, the valid refresh token is not rotated or consumed. Restart interactive authorization; UOA never silently changes the team.',
    'team-switch contract':
      "The custom grant requires refresh_token + organization_id + team_id and no operation id. It checks the exact target ACTIVE memberships, current product policy, current target 2FA policy, and the family's immutable authorization-code 2FA assurance before rotating once to that exact scope. An ordinary refresh always preserves scope. Same-scope requests are rejected without consumption.",
    'team-switch errors':
      'Before an edge commits, 403 TEAM_NOT_AVAILABLE means the exact pair is unavailable or policy denies it and 403 INTERACTION_REQUIRED means fresh interactive assurance is needed; both leave the source live. 409 TEAM_SWITCH_CONFLICT means the deterministic family already advanced under another grant or target and does not revoke that valid family. If an exact response-loss retry finds its already-committed target no longer policy-valid, UOA retires only that family and returns authenticated 401 INVALID_REFRESH_TOKEN. Invalid/post-grace reuse also returns that stable code while keeping the underlying reason opaque; client-authentication failures remain generic.',
    'refresh response-loss recovery':
      "For 120 seconds after rotation, retrying the same predecessor with the same authenticated app credential, grant intent, exact team target, and client context returns the verified current successor. Every descendant must retain that operation's expected scope; a later scope transition produces TEAM_SWITCH_CONFLICT instead of returning changed scope. Outside the window, any predecessor use revokes the family and prior access-token version.",
  },
};
