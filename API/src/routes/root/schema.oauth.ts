import type { EndpointSchema } from './schema.js';

// Public-client / MCP OAuth profile (brief §22.14). Standards endpoints for public
// clients (PKCE, no secret); interactive routes require the explicit
// MCP_OAUTH_PUBLIC_PROFILE_ENABLED gate in addition to the signing key.
export const oauthEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/.well-known/oauth-authorization-server',
    description: 'RFC 8414 authorization-server metadata for the public-client / MCP profile',
    auth: 'public; 404 unless MCP_OAUTH_PUBLIC_PROFILE_ENABLED=true and profile config is valid',
    response: {
      issuer: 'string',
      authorization_endpoint: 'string',
      token_endpoint: 'string',
      registration_endpoint: 'string',
      revocation_endpoint: 'string — RFC 7009 /oauth/revoke',
      jwks_uri: 'string',
      grant_types_supported:
        'string[] — ["authorization_code", "refresh_token"]; refresh_token is issued only to registered native-app clients',
      code_challenge_methods_supported: 'string[] — ["S256"]',
      token_endpoint_auth_methods_supported: 'string[] — ["none"]',
      revocation_endpoint_auth_methods_supported: 'string[] — ["none"]',
    },
  },
  {
    method: 'GET',
    path: '/oauth/jwks.json',
    description:
      'Public JWKS for verifying the RS256 tokens UOA issues: confidential resource tokens, optional public-profile tokens, and — when USER_ACCESS_TOKEN_* is configured — the user access token relying parties receive. Verify with algorithms=["RS256"], iss=AUTH_SERVICE_IDENTIFIER, aud="uoa:access-token"; kid separates the key classes. Signature verification is defence in depth and does not replace UOA as the authority on revocation (see Docs/Auth/access-token-verification.md). Separate from the config JWKS at /.well-known/jwks.json.',
    auth: 'public when at least one RS256 signing key is configured; 404 otherwise',
    response: { keys: 'array — public RSA JWKs only' },
  },
  {
    method: 'POST',
    path: '/oauth/register',
    description: 'RFC 7591 dynamic client registration (PUBLIC clients only; no secret issued)',
    auth: 'public (IP rate-limited); 404 unless MCP_OAUTH_PUBLIC_PROFILE_ENABLED=true and profile config is valid',
    body: {
      redirect_uris: 'string[] (required; https / loopback http / native scheme)',
      client_name: 'string (optional)',
      app_id: 'optional admin-registered reverse-domain identifier; stored policy controls branding, callbacks and scopes',
      token_endpoint_auth_method: 'string (optional; must be "none")',
      scope: 'string (optional)',
    },
    response: {
      client_id: 'string',
      redirect_uris: 'string[]',
      grant_types:
        'string[] — ["authorization_code", "refresh_token"] when app_id resolved to an enabled native app; otherwise ["authorization_code"]',
      token_endpoint_auth_method: 'none',
    },
  },
  {
    method: 'GET',
    path: '/oauth/authorize',
    description:
      'Authorization endpoint — validates client_id+redirect_uri+PKCE, renders the first-party login UI',
    auth: 'public; 404 unless MCP_OAUTH_PUBLIC_PROFILE_ENABLED=true and profile config is valid',
    query: {
      response_type: 'code',
      client_id: 'string (required)',
      redirect_uri: 'string (required; must match a registered redirect URI)',
      code_challenge: 'string (required; PKCE S256)',
      code_challenge_method: 'S256 (required)',
      state: 'string (optional)',
      scope: 'string (optional; preserved through signing and bound to the authorization code)',
      resource: 'string (optional; RFC 8707 — becomes the token aud)',
    },
    response: { 200: 'Login UI HTML' },
  },
  {
    method: 'POST',
    path: '/oauth/login',
    description:
      'Public email/password login (no secret); issues an auth code and returns the redirect target',
    auth: 'public (IP rate-limited); 404 unless MCP_OAUTH_PUBLIC_PROFILE_ENABLED=true and profile config is valid',
    query: {
      client_id: 'string (required)',
      redirect_uri: 'string (required)',
      code_challenge: 'string (required; PKCE S256)',
      code_challenge_method: 'S256 (required)',
      state: 'string (optional)',
      scope: 'string (optional; preserved exactly and cannot be widened at token exchange)',
      resource: 'string (optional)',
    },
    body: {
      email: 'string (required)',
      password: 'string (required)',
      remember_me: 'boolean (optional)',
      code: 'six digit authenticator code (optional; resubmit password when twofa_required)',
      setup_token: 'required with code when completing twofa_enroll_required',
    },
    response: {
      redirect_to: 'string — redirect_uri?code=&state= (on success)',
      twofa_required: 'boolean — resubmit password with authenticator code',
      twofa_enroll_required: 'boolean — enroll using returned setup_token and manual_secret, then resubmit password, setup_token and code',
    },
  },
  {
    method: 'POST',
    path: '/oauth/token',
    description:
      'Public PKCE authorization-code exchange (no client secret) and, for registered native-app clients only, the rotating refresh-token grant; returns a resource-bound RS256 access token',
    auth: 'public (PKCE or bound refresh token; separate IP rate-limit buckets for code and refresh grants); 404 unless MCP_OAUTH_PUBLIC_PROFILE_ENABLED=true and profile config is valid',
    body: {
      grant_type: 'authorization_code (optional, default) | refresh_token',
      code: 'string (authorization_code: required)',
      redirect_uri: 'string (authorization_code: required)',
      code_verifier: 'string (authorization_code: required; PKCE)',
      refresh_token: 'string (refresh_token: required; the latest opaque refresh token)',
      client_id: 'string (required; a refresh token is bound to the exact client that obtained it)',
      scope:
        'string (optional; when supplied, must exactly match the originally granted scope — never widened or narrowed)',
    },
    response: {
      access_token: 'string — RS256 JWT, aud = resource (or the issuer when none was granted)',
      token_type: 'Bearer',
      expires_in: 'number (seconds)',
      refresh_token:
        'string — native-app clients only: opaque, rotated on every refresh; persist the newest one before using the access token',
      refresh_token_expires_in: 'number (seconds) — native-app clients only',
      scope: 'string — refresh_token grant only: the originally granted scope (omitted when none was granted)',
    },
    notes:
      'Refresh tokens are issued only to clients registered with an enabled native-app app_id; plain dynamic registrations are unchanged. Each refresh rotates the token within its family (REFRESH_TOKEN_TTL_DAYS lifetime, inherited on rotation). Re-presenting the immediate predecessor within 120 s returns the same live successor; a predecessor used later revokes the whole family and increments the user credential epoch. Every refresh re-checks, in one transaction, the client and its native-app policy, the user, the credential epoch the family was issued under (password reset, 2FA changes, logout anywhere or reuse revocation end it), the second-factor and signature policy, and the scope/resource allowlists, and never issues broader scope or resource than the original grant. Every refusal is 401 with the generic error body; malformed bodies are 400. Responses are Cache-Control: no-store.',
  },
  {
    method: 'POST',
    path: '/oauth/revoke',
    description:
      'RFC 7009 revocation of a public-client refresh token; revokes its whole family when the token belongs to the presenting client',
    auth: 'public (client_id binding; IP rate-limited); 404 unless MCP_OAUTH_PUBLIC_PROFILE_ENABLED=true and profile config is valid',
    body: {
      token: 'string (required; the refresh token)',
      client_id: 'string (required; must be the client the token was issued to)',
      token_type_hint: 'string (optional; ignored)',
    },
    response: { 200: '{} — always, including unknown, foreign, repeated or malformed tokens' },
    notes:
      'Same logout semantics as /auth/revoke: the family is revoked and the user credential epoch is incremented once, which invalidates current access tokens and ends every other public-client refresh family of that user. Cache-Control: no-store.',
  },
];
