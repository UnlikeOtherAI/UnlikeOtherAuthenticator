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
      jwks_uri: 'string',
      code_challenge_methods_supported: 'string[] — ["S256"]',
      token_endpoint_auth_methods_supported: 'string[] — ["none"]',
    },
  },
  {
    method: 'GET',
    path: '/oauth/jwks.json',
    description:
      'Public JWKS for verifying confidential and optional public-profile RS256 access tokens (separate from config JWKS)',
    auth: 'public when the RS256 access-token signing key is configured',
    response: { keys: 'array — public RSA JWKs only' },
  },
  {
    method: 'POST',
    path: '/oauth/register',
    description: 'RFC 7591 dynamic client registration (PUBLIC clients only; no secret issued)',
    auth:
      'public (IP rate-limited); 404 unless MCP_OAUTH_PUBLIC_PROFILE_ENABLED=true and profile config is valid',
    body: {
      redirect_uris: 'string[] (required; https / loopback http / native scheme)',
      client_name: 'string (optional)',
      token_endpoint_auth_method: 'string (optional; must be "none")',
      scope: 'string (optional)',
    },
    response: {
      client_id: 'string',
      redirect_uris: 'string[]',
      token_endpoint_auth_method: 'none',
    },
  },
  {
    method: 'GET',
    path: '/oauth/authorize',
    description: 'Authorization endpoint — validates client_id+redirect_uri+PKCE, renders the first-party login UI',
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
    description: 'Public email/password login (no secret); issues an auth code and returns the redirect target',
    auth:
      'public (IP rate-limited); 404 unless MCP_OAUTH_PUBLIC_PROFILE_ENABLED=true and profile config is valid',
    query: {
      client_id: 'string (required)',
      redirect_uri: 'string (required)',
      code_challenge: 'string (required; PKCE S256)',
      code_challenge_method: 'S256 (required)',
      state: 'string (optional)',
      scope: 'string (optional; preserved exactly and cannot be widened at token exchange)',
      resource: 'string (optional)',
    },
    body: { email: 'string (required)', password: 'string (required)', remember_me: 'boolean (optional)' },
    response: {
      redirect_to: 'string — redirect_uri?code=&state= (on success)',
      twofa_required: 'boolean — true when 2FA blocks completion (pending /oauth 2FA step)',
    },
  },
  {
    method: 'POST',
    path: '/oauth/token',
    description: 'Public PKCE authorization-code exchange (no client secret); returns a resource-bound RS256 access token',
    auth:
      'public (PKCE; IP rate-limited); 404 unless MCP_OAUTH_PUBLIC_PROFILE_ENABLED=true and profile config is valid',
    body: {
      grant_type: 'authorization_code (optional, default)',
      code: 'string (required)',
      redirect_uri: 'string (required)',
      code_verifier: 'string (required; PKCE)',
      client_id: 'string (required)',
      scope: 'string (optional; when supplied, must exactly match the authorize-time scope)',
    },
    response: {
      access_token: 'string — RS256 JWT, aud = resource',
      token_type: 'Bearer',
      expires_in: 'number (seconds)',
    },
  },
];
