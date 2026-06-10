import type { EndpointSchema } from './schema.js';

export const authEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/auth',
    description: 'OAuth entrypoint — renders the auth UI',
    query: {
      config_url: 'string (required) — HTTPS URL to fetch signed config JWT',
      redirect_url: 'string (optional) — OAuth redirect URL override (redirect_uri also accepted)',
      code_challenge: 'string (required for sign-in actions) — exactly 43-char PKCE S256 challenge',
      code_challenge_method: '"S256" when code_challenge is sent',
    },
  },
  {
    method: 'POST',
    path: '/auth/login',
    description: 'Email/password login',
    auth: 'config_url query param',
    query: {
      redirect_url: 'string (optional, redirect_uri also accepted)',
      code_challenge: 'string (required) — exactly 43-char PKCE S256 challenge',
      code_challenge_method: '"S256" (required)',
      request_access:
        'string (optional) — when truthy, auto-grant or create a pending access request',
    },
    body: {
      email: 'string (required)',
      password: 'string (required)',
      remember_me: 'boolean (optional) — defaults to session.remember_me_default from config',
    },
    response: {
      ok: 'true',
      kind: '"twofa_enroll_required" when mandatory 2FA setup must complete before code grant',
      code: 'authorization code',
      redirect_to: 'full redirect URL with code',
      twofa_required: 'true (only if 2FA needed)',
      twofa_token: 'challenge token (only if 2FA needed)',
      twofa_enroll_required: 'true (only if effective policy is required and user is not enrolled)',
      setup_token: 'short-lived 2FA setup token (only with twofa_enroll_required)',
      otpauth_uri: 'otpauth:// URI (only with twofa_enroll_required)',
      qr_svg: 'self-contained data:image/svg+xml;base64 QR with logo (only with twofa_enroll_required)',
      manual_secret: 'manual-entry TOTP secret text (only with twofa_enroll_required)',
      access_request_status: '"pending" when request_access created a pending access request',
    },
  },
  {
    method: 'POST',
    path: '/auth/register',
    description: 'User registration — sends verification email',
    auth: 'config_url query param',
    query: {
      redirect_url: 'string (optional)',
      request_access: 'string (optional) — bypass gating and request configured-team access',
      code_challenge:
        'string (required) — exactly 43-char PKCE S256 challenge preserved through email verification',
      code_challenge_method: '"S256" (required)',
    },
    body: { email: 'string (required)' },
    response: { message: '"We sent instructions to your email" (always, no enumeration)' },
  },
  {
    method: 'POST',
    path: '/auth/verify-email',
    description: 'Complete email verification (registration)',
    auth: 'config_url query param',
    query: {
      redirect_url: 'string (optional)',
      code_challenge: 'string (required) — exactly 43-char PKCE S256 challenge',
      code_challenge_method: '"S256" (required)',
      request_access: 'string (optional) — auto-grant or create a pending access request',
    },
    body: {
      token: 'string (required) — email verification token',
      password: 'string (optional) — required for password_required registration mode',
    },
    response: {
      ok: 'true',
      code: 'authorization code',
      redirect_to: 'redirect URL',
      access_request_status: '"pending" when request_access created a pending access request',
    },
  },
  {
    method: 'POST',
    path: '/auth/token',
    description: 'Exchange authorization code or refresh token for access + refresh tokens',
    auth: 'config_url query param + domain hash bearer token',
    body: {
      'grant_type?': '"authorization_code" (default) or "refresh_token"',
      'code?': 'authorization code (for authorization_code grant)',
      'redirect_url?': 'required for authorization_code grant; must match issued URL',
      'code_verifier?': 'required for authorization_code grant; must match the S256 challenge',
      'refresh_token?': 'refresh token (for refresh_token grant)',
    },
    response: {
      access_token:
        'HS256 JWT signed with the deployment SHARED_SECRET. aud="uoa:access-token". RPs cannot and should not verify it cryptographically — trust comes from the authenticated backend channel. See /api > access_token.claims for the claim schema.',
      expires_in: 'number — seconds until access_token expiry',
      refresh_token: 'string — opaque, server-side only; never hand to the browser',
      refresh_token_expires_in: 'number — seconds until refresh_token expiry',
      token_type: '"Bearer"',
      'firstLogin?':
        'object { memberships: { orgs, teams }, pending_invites, capabilities { can_create_org, can_accept_invite } } — included on authorization_code exchange when org_features.enabled is true. memberships.orgs[] = { orgId, role } camelCase; memberships.teams[] = { teamId, orgId, role } camelCase; pending_invites[] = { inviteId, type, orgId, teamId, teamName } camelCase. Not included on refresh_token grants.',
      '[note]':
        'There is NO top-level `user` field. User identity lives inside access_token claims (read claims.sub). The outer envelope is snake_case; firstLogin.* IDs are camelCase.',
    },
  },
  {
    method: 'POST',
    path: '/auth/revoke',
    description: 'Revoke refresh token family and the user access tokens (logout)',
    auth: 'config_url query param + domain hash bearer token',
    body: { refresh_token: 'string (required)' },
    response: { ok: 'true' },
  },
  {
    method: 'POST',
    path: '/auth/reset-password/request',
    description: 'Initiate password reset (no enumeration)',
    auth: 'config_url query param',
    body: { email: 'string (required)' },
    response: { message: '"We sent instructions to your email" (always)' },
  },
  {
    method: 'POST',
    path: '/auth/reset-password',
    description: 'Complete password reset with token',
    auth: 'config_url query param',
    body: { token: 'string (required)', password: 'string (required)' },
    response: { ok: 'true' },
  },
  {
    method: 'GET',
    path: '/auth/email/reset-password',
    description: 'Email link landing — renders set-password UI',
    query: { token: 'string (required)', config_url: 'string (required)' },
  },
  {
    method: 'GET',
    path: '/auth/email/twofa-reset',
    description: 'Email link landing for 2FA reset — renders confirmation page only',
    query: { token: 'string (required)', config_url: 'string (required)' },
  },
  {
    method: 'POST',
    path: '/auth/email/twofa-reset/confirm',
    description: 'Confirm email-based 2FA reset and consume the one-time token',
    auth: 'config_url query param',
    query: { token: 'string (required)', config_url: 'string (required)' },
  },
  {
    method: 'GET',
    path: '/auth/email/link',
    description: 'Email registration/login link landing',
    query: {
      token: 'string (required)',
      config_url: 'string (required)',
      redirect_url: 'string (optional)',
      code_challenge:
        'string (required) — exactly 43-char PKCE S256 challenge preserved through email verification',
      code_challenge_method: '"S256" (required)',
      request_access: 'string (optional) — preserves access-request intent through email auth',
    },
  },
  {
    method: 'GET',
    path: '/auth/email/team-invite',
    description: 'Team invite landing page with accept/decline actions',
    query: {
      token: 'string (required)',
      config_url: 'string (required)',
      redirect_url: 'string (optional)',
    },
  },
  {
    method: 'GET',
    path: '/auth/email/team-invite/decline',
    description: 'Decline a team invitation',
    query: { token: 'string (required)', config_url: 'string (required)' },
  },
  {
    method: 'GET',
    path: '/auth/email/team-invite-open/:inviteId.gif',
    description: 'Tracking pixel for team invite open events',
  },
  {
    method: 'GET',
    path: '/auth/social/:provider',
    description:
      'Initiate social OAuth flow (google, facebook, github, linkedin, apple). Sets a signed, HttpOnly `uoa_social_state` cookie (SameSite=Lax, Path=/auth) that binds the OAuth `state` to the browser; the cookie must be returned to /auth/callback.',
    query: {
      config_url: 'string (required)',
      redirect_url: 'string (optional)',
      code_challenge: 'string (required) — exactly 43-char PKCE S256 challenge',
      code_challenge_method: '"S256" (required)',
      request_access:
        'string (optional) — routes social auth through configured-team access policy',
    },
  },
  {
    method: 'GET',
    path: '/auth/callback/:provider',
    description:
      'OAuth provider callback. Requires the signed `uoa_social_state` cookie set at /auth/social to match the nonce embedded in `state` (login-CSRF protection); the cookie is single-use and cleared on consume.',
  },
  {
    method: 'GET',
    path: '/auth/domain-mapping',
    description: 'Look up org/team mapping for an email domain',
    auth: 'config_url query param + domain hash bearer token',
    query: {
      config_url: 'string (required)',
      email_domain: 'string (required)',
    },
  },
  {
    method: 'POST',
    path: '/2fa/setup',
    description: 'Start or render TOTP 2FA enrollment for a user',
    auth: 'config_url query param. Normal self-service requires X-UOA-Access-Token; forced enrollment rendering may send setup_token in the body before an auth code exists.',
    body: {
      setup_token:
        'string (optional) — when present, re-renders the setup QR from the encrypted secret in the token',
    },
    response: {
      otpauth_uri: 'otpauth:// URI for the authenticator app',
      qr_svg: 'self-contained data:image/svg+xml;base64 QR with config logo embedded',
      setup_token:
        'short-lived signed JWT containing userId, encryptedSecret, domain, and configUrl',
      manual_secret: 'base32 secret for manual authenticator entry',
    },
  },
  {
    method: 'POST',
    path: '/2fa/enroll',
    description: 'Verify the initial TOTP code and enable 2FA',
    auth: 'config_url query param + setup_token body. X-UOA-Access-Token is accepted for normal self-service binding but is not required for forced enrollment before code grant.',
    body: {
      setup_token: 'string (required) — short-lived setup token from /2fa/setup or login enforcement',
      code: 'string (required) — current 6-digit TOTP',
    },
    response: {
      ok: 'true',
      code: 'authorization code when enroll completes a forced login',
      redirect_to: 'redirect URL when enroll completes a forced login',
      access_request_status: '"pending" when forced login created a pending access request',
    },
  },
  {
    method: 'POST',
    path: '/2fa/disable',
    description: 'Disable enrolled 2FA for the access-token user',
    auth: 'config_url query param + X-UOA-Access-Token. Blocked when effective policy is required.',
    body: { code: 'string (required) — current 6-digit TOTP' },
    response: { ok: 'true' },
  },
  {
    method: 'POST',
    path: '/2fa/verify',
    description: 'Verify TOTP 2FA code during login',
    auth: 'config_url query param',
    body: { twofa_token: 'string (required)', code: 'string (required) — 6-digit TOTP' },
    response: {
      ok: 'true',
      code: 'authorization code',
      redirect_to: 'redirect URL',
      access_request_status: '"pending" when request_access created a pending access request',
    },
  },
  {
    method: 'POST',
    path: '/2fa/reset/request',
    description: 'Initiate 2FA reset via email',
    auth: 'config_url query param',
    body: { email: 'string (required)' },
  },
  {
    method: 'POST',
    path: '/2fa/reset',
    description: 'Complete 2FA reset with email token',
    auth: 'config_url query param',
    body: { token: 'string (required)' },
    response: { ok: 'true' },
  },
  {
    method: 'GET',
    path: '/i18n/get',
    description: 'Fetch translation data for a language',
    query: { lang: 'string (required)', config_url: 'string (required)' },
  },
];
