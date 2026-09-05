import type { EndpointSchema } from './schema.js';
import { authTokenEndpoint } from './schema.auth-token.js';

export const authEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/auth',
    description: 'OAuth entrypoint — renders the auth UI',
    query: {
      state:
        'string (optional, ≤2048) — opaque relying-party CSRF value, forwarded to the auth UI and replayed on the call that begins the flow. Bound to that login and echoed beside `code` on the final redirect. PKCE protects the code exchange; `state` protects the redirect binding, and neither substitutes for the other.',
      config_url: 'string (required) — HTTPS URL to fetch signed config JWT',
      redirect_url: 'string (optional) — OAuth redirect URL override (redirect_uri also accepted)',
      code_challenge: 'string (required for sign-in actions) — exactly 43-char PKCE S256 challenge',
      code_challenge_method: '"S256" when code_challenge is sent',
      team_hint:
        "string (optional, ≤256 chars, id/slug-safe charset) — chooser preselect / one-click team switch (design §11.4): when the team chooser renders, a team already in the verified user's own chooser payload matching this teamId or slug is auto-selected, same as the single-team auto-skip. Client-side ONLY — an invalid or non-matching value is silently ignored (chooser renders normally) and select-team's server-side product-policy + exact ACTIVE-membership check remains the sole authority; it can never select a team the user doesn't already have.",
    },
  },
  {
    method: 'POST',
    path: '/auth/login',
    description:
      'Email/password login. team_selection="auto" may return the chooser; "off" suppresses it. A server-recognized product still resolves its mandatory exact team before 2FA, applies that Organisation policy strongest-wins, and fails closed on ambiguous placement.',
    auth: 'config_url query param',
    query: {
      state:
        'string (optional, ≤2048) — opaque relying-party CSRF value. UOA does not interpret it; it is bound to this login (login_token, 2FA bridge, social state) and echoed verbatim beside `code` on the final redirect, and beside `error` on a failed social callback. Later hops must not re-supply it: a hop presenting a different value is refused.',
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
      qr_svg:
        'self-contained data:image/svg+xml;base64 QR with logo (only with twofa_enroll_required)',
      manual_secret: 'manual-entry TOTP secret text (only with twofa_enroll_required)',
      access_request_status: '"pending" when request_access created a pending access request',
    },
  },
  {
    method: 'POST',
    path: '/auth/start',
    description:
      'Slack-style email-first entry point — superset of /auth/register. Always sends the existing magic-link instructions; additionally issues a 6-digit sign-in code when config.login_flow.email_code_enabled is true. Response is always the same generic message (no enumeration).',
    auth: 'config_url query param',
    query: {
      state:
        'string (optional, ≤2048) — opaque relying-party CSRF value. UOA does not interpret it; it is bound to this login (login_token, 2FA bridge, social state) and echoed verbatim beside `code` on the final redirect, and beside `error` on a failed social callback. Later hops must not re-supply it: a hop presenting a different value is refused.',
      redirect_url: 'string (optional, redirect_uri also accepted)',
      code_challenge: 'string (required) — exactly 43-char PKCE S256 challenge',
      code_challenge_method: '"S256" (required)',
      request_access:
        'string (optional) — when truthy, auto-grant or create a pending access request',
    },
    body: { email: 'string (required)' },
    response: {
      message: '"We sent instructions to your email" (always, regardless of email code issuance)',
      code: '"EMAIL_ALREADY_REGISTERED" with HTTP 409 only when existing_user_registration_behavior="inline_sign_in"',
    },
  },
  {
    method: 'POST',
    path: '/auth/verify-code',
    description:
      'Verify a 6-digit sign-in code issued by /auth/start (requires config.login_flow.email_code_enabled). 5 wrong attempts kill the code; every failure mode (no code, wrong code, expired, dead) returns the same generic auth error. IP + email rate-limited. With team_selection="off", recognized products suppress the chooser but resolve and bind their exact team before 2FA.',
    auth: 'config_url query param',
    query: {
      state:
        'string (optional, ≤2048) — opaque relying-party CSRF value. UOA does not interpret it; it is bound to this login (login_token, 2FA bridge, social state) and echoed verbatim beside `code` on the final redirect, and beside `error` on a failed social callback. Later hops must not re-supply it: a hop presenting a different value is refused.',
      redirect_url: 'string (optional, redirect_uri also accepted)',
      code_challenge: 'string (required) — exactly 43-char PKCE S256 challenge',
      code_challenge_method: '"S256" (required)',
      request_access:
        'string (optional) — when truthy, auto-grant or create a pending access request',
    },
    body: {
      email: 'string (required)',
      code: 'string (required) — 6-digit sign-in code',
      remember_me: 'boolean (optional) — defaults to session.remember_me_default from config',
    },
    response: {
      'login_token?':
        'short-lived, one-time chooser capability (only when config.login_flow.team_selection="auto") — binds this verified user/domain to the exact config URL + parsed-config fingerprint, redirect, PKCE, remember-me, request-access, expiry, and JTI; authorizes no other continuation',
      'teams?':
        "array of { teamId, orgId, name, slug, role, iconUrl, avatarImageUrl, orgName, orgSlug } — this user's ACTIVE team memberships on this domain (only with login_token). avatarImageUrl is the public /teams/:teamId/avatar form (never null, no credential needed) — the chooser renders in a popup that holds no bearer",
      'pending_invites?':
        'array of { inviteId, teamName, invitedBy } — pending invites for this email on this domain (only with login_token)',
      'can_create_org?': 'boolean (only with login_token)',
      'creatable_orgs?':
        'array of { orgId, orgName } — organisations this user may add a team to via POST /auth/create-team (ACTIVE owner/admin there + org_features.allow_user_create_team). Empty unless the domain opted in. Distinct from can_create_org, which permits creating a new organisation',
      ok: 'true (when team_selection is "off" — finalizes immediately like /auth/login)',
      code: 'authorization code (team_selection "off" branch only)',
      redirect_to: 'full redirect URL with code (team_selection "off" branch only)',
      twofa_required: 'true (only if 2FA needed, team_selection "off" branch only)',
      twofa_token: 'challenge token (only if 2FA needed, team_selection "off" branch only)',
    },
  },
  {
    method: 'POST',
    path: '/auth/select-team',
    description:
      'Choose a team (or accept/decline a pending invite, or redeem a shareable invite link) using the login_token bridge from a verified identity path. Rejects generically if the signature/expiry/config URL/semantic config fingerprint differs, if any caller-supplied redirect/PKCE/remember-me/request-access field retargets the signed continuation, if a selected/accepted exact org + team scope is not ACTIVE, or if an invite link is invalid or cannot produce an ACTIVE exact scope. Final selection claims the hashed JTI first in the transaction, before invite/audit/access-request-email effects; a concurrent replay cannot perform those effects, while later failure rolls the claim back for retry. Choices and decline are non-consuming. Scope is revalidated after 2FA/signatures immediately before code issuance and again inside the single code-consume/token-creation transaction at exchange. The chooser-selection and code-exchange transactions hold the ordered membership locks shared with lifecycle writers; post-2FA/signature code issuance revalidates but does not hold those locks.',
    auth: 'config_url query param + login_token body field',
    query: {
      redirect_url: 'string (optional, redirect_uri also accepted)',
      code_challenge: 'string (required) — exactly 43-char PKCE S256 challenge',
      code_challenge_method: '"S256" (required)',
      request_access:
        'string (optional) — when truthy, auto-grant or create a pending access request',
    },
    body: {
      login_token: 'string (required) — bridge token from /auth/verify-code or /auth/login',
      'teamId?': 'string (optional) — an ACTIVE team membership to select',
      'inviteId?': 'string (optional) — a pending invite id (accept or decline via `action`)',
      'inviteLinkToken?':
        'string (optional) — a shareable team invite-link token (from GET /auth/team-invite-link/:token). Mutually exclusive with teamId/inviteId; redeems the link and finalizes scoped to its team, only now that identity is verified — an invite link never grants membership on its own.',
      'action?': '"accept" | "decline" (optional) — default "accept" when inviteId is present',
      remember_me:
        'boolean (optional) — when present must equal the value signed at identity verification; omission uses that signed value',
    },
    response: {
      ok: 'true',
      code: 'authorization code, now carrying the selected team scope (active claim on exchange) when a team/invite was resolved',
      redirect_to: 'full redirect URL with code',
      twofa_required: 'true (only if the selected org requires 2FA)',
      twofa_token: 'challenge token (only if 2FA needed)',
      twofa_enroll_required:
        'true (only if the selected org requires 2FA and the user is not enrolled)',
      'login_token?': 'refreshed bridge token + chooser payload (decline-invite response only)',
      access_request_status: '"pending" when request_access created a pending access request',
    },
  },
  {
    method: 'POST',
    path: '/auth/create-organisation',
    description:
      "Create and immediately select a verified user's first team from the hosted SSO chooser. The login_token bridge and all supplied continuation fields must match the signed identity-verification continuation. Within one transaction, UOA claims the bridge token, creates the organisation and its default team with the requested hosted-chooser visibility, validates the exact ACTIVE client team scope, and completes required 2FA/code issuance. The organisation slug is the canonical tenant DNS label: it is exposed in the resulting access token as active.tenantSlug and is unique for the client domain. Team slugs remain local to their organisation and must not be used as tenant subdomains.",
    auth: 'config_url query param + login_token body field',
    query: {
      redirect_url: 'string (optional, redirect_uri also accepted)',
      code_challenge: 'string (required) — exactly 43-char PKCE S256 challenge',
      code_challenge_method: '"S256" (required)',
      request_access:
        'string (optional) — when truthy, auto-grant or create a pending access request',
    },
    body: {
      login_token: 'string (required) — bridge token from /auth/verify-code or /auth/login',
      name: 'string (required, 1–100 characters after trimming) — team name; UOA derives the organisation/tenant slug',
      join_policy:
        '"HIDDEN" | "INVITE_ONLY" | "OPEN_TO_ORG" (optional; defaults to INVITE_ONLY) — default-team visibility. HIDDEN is private/discoverable only by invitees; OPEN_TO_ORG lets active organisation members join themselves',
      remember_me:
        'boolean (optional) — when present must equal the value signed at identity verification; omission uses that signed value',
    },
    response: {
      ok: 'true',
      code: 'authorization code carrying the new selected team scope when issuance completes',
      redirect_to: 'full redirect URL with code',
      twofa_required: 'true when the new selected org requires enrolled 2FA',
      twofa_token: 'challenge token (only if 2FA needed)',
      twofa_enroll_required:
        'true when the new selected org requires 2FA and the user is not enrolled',
      access_request_status: '"pending" when request_access created a pending access request',
    },
  },
  {
    method: 'POST',
    path: '/auth/create-team',
    description:
      "Create and immediately select a FURTHER team (team) inside an organisation the verified user already belongs to, from the hosted SSO chooser. The sibling of /auth/create-organisation, which creates a new organisation: an organisation is the level above a team, so this route writes into an existing tenant and is authorized accordingly — the acting user must be an ACTIVE owner/admin of org_id (the same rule POST /org/organisations/:orgId/teams enforces), the organisation must belong to this config's domain, and the domain must set org_features.allow_user_create_team. The org's max_teams_per_org cap still applies. Same transaction envelope as /auth/create-organisation: the bridge token is claimed alongside the new team with its requested hosted-chooser visibility, the creator's ACTIVE team membership, the team-scope validation, and required 2FA/code issuance. The chooser's creatable_orgs lists exactly the organisations this will accept.",
    auth: 'config_url query param + login_token body field',
    query: {
      redirect_url: 'string (optional, redirect_uri also accepted)',
      code_challenge: 'string (required) — exactly 43-char PKCE S256 challenge',
      code_challenge_method: '"S256" (required)',
      request_access:
        'string (optional) — when truthy, auto-grant or create a pending access request',
    },
    body: {
      login_token: 'string (required) — bridge token from /auth/verify-code or /auth/login',
      org_id:
        "string (required) — an organisation from the chooser's creatable_orgs; anything else is the generic auth failure",
      name: 'string (required, 1–100 characters after trimming) — team name; UOA derives the team slug, local to the organisation',
      join_policy:
        '"HIDDEN" | "INVITE_ONLY" | "OPEN_TO_ORG" (optional; defaults to INVITE_ONLY) — team visibility. HIDDEN is private/discoverable only by invitees; OPEN_TO_ORG lets active organisation members join themselves',
      remember_me:
        'boolean (optional) — when present must equal the value signed at identity verification; omission uses that signed value',
    },
    response: {
      ok: 'true',
      code: 'authorization code carrying the new selected team scope when issuance completes',
      redirect_to: 'full redirect URL with code',
      twofa_required: 'true when the org requires enrolled 2FA',
      twofa_token: 'challenge token (only if 2FA needed)',
      twofa_enroll_required: 'true when the org requires 2FA and the user is not enrolled',
      access_request_status: '"pending" when request_access created a pending access request',
    },
  },
  {
    method: 'POST',
    path: '/auth/session-choices',
    description:
      'Hydrate the team-chooser payload for a login_token bridge seeded via a redirect, since a GET redirect cannot inline chooser JSON. Verifies signature, expiry, exact config URL, and the canonical fingerprint of the currently verified parsed config. This read is deliberately non-consuming; only final selection claims the hashed JTI. Introduces no enumeration because it answers only for an already-verified capability.',
    auth: 'config_url query param + login_token body field',
    query: { config_url: 'string (required)' },
    body: {
      login_token:
        'string (required) — bridge token from the redirecting flow (e.g. the social callback)',
    },
    response: {
      teams:
        "array of { teamId, orgId, name, slug, role, iconUrl, avatarImageUrl, orgName, orgSlug } — this user's ACTIVE team memberships on this domain. avatarImageUrl is the public /teams/:teamId/avatar form (never null, no credential needed)",
      pending_invites:
        'array of { inviteId, teamName, invitedBy } — pending invites for this email on this domain',
      can_create_org: 'boolean',
      creatable_orgs:
        'array of { orgId, orgName } — organisations this user may add a team to via POST /auth/create-team',
    },
  },
  {
    method: 'POST',
    path: '/auth/register',
    description:
      'User registration — sends verification email, or an inline already-registered response when the signed config opts in',
    auth: 'config_url query param',
    query: {
      state:
        'string (optional, ≤2048) — opaque relying-party CSRF value. UOA does not interpret it; it is bound to this login (login_token, 2FA bridge, social state) and echoed verbatim beside `code` on the final redirect, and beside `error` on a failed social callback. Later hops must not re-supply it: a hop presenting a different value is refused.',
      redirect_url: 'string (optional)',
      request_access: 'string (optional) — bypass gating and request configured-team access',
      code_challenge:
        'string (required) — exactly 43-char PKCE S256 challenge preserved through email verification',
      code_challenge_method: '"S256" (required)',
    },
    body: { email: 'string (required)' },
    response: {
      message: '"We sent instructions to your email" (default, no enumeration)',
      code: '"EMAIL_ALREADY_REGISTERED" with HTTP 409 only when existing_user_registration_behavior="inline_sign_in"',
    },
  },
  {
    method: 'POST',
    path: '/auth/verify-email',
    description:
      'Complete email verification (registration). For a non-invite token with config.login_flow.team_selection="auto", 2+ ACTIVE teams, a pending invite, or zero teams with can_create_org return the team chooser. Exactly one ACTIVE team/no invite is selected server-side and carried through applicable 2FA into the authorization code and active claim. An invite-bound token is already an explicit selection: its accepted orgId/teamId bypasses the chooser, still enforces 2FA, and is preserved through code/access/refresh rotation. A direct email invitation may omit PKCE: it accepts only its live token and returns invite_accepted without issuing an OAuth code. team_selection="off" leaves legacy clients unscoped, but a recognized product pre-binds one exact team before 2FA without showing the chooser.',
    auth: 'config_url query param',
    query: {
      state:
        'string (optional, ≤2048) — opaque relying-party CSRF value. UOA does not interpret it; it is bound to this login (login_token, 2FA bridge, social state) and echoed verbatim beside `code` on the final redirect, and beside `error` on a failed social callback. Later hops must not re-supply it: a hop presenting a different value is refused.',
      redirect_url: 'string (optional)',
      code_challenge:
        'string (required except a direct team invitation) — exactly 43-char PKCE S256 challenge',
      code_challenge_method: '"S256" (required whenever code_challenge is sent)',
      request_access: 'string (optional) — auto-grant or create a pending access request',
    },
    body: {
      token: 'string (required) — email verification token',
      password: 'string (optional) — required for password_required registration mode',
    },
    response: {
      ok: 'true (team_selection "off"/skipped branch only — finalizes immediately)',
      invite_accepted:
        'true only for a direct live team invitation without PKCE; no authorization code is issued',
      code: 'authorization code (team_selection "off"/skipped branch only)',
      redirect_to: 'redirect URL (team_selection "off"/skipped branch only)',
      access_request_status: '"pending" when request_access created a pending access request',
      twofa_required: 'true when the selected/accepted team requires enrolled 2FA',
      twofa_token:
        'team-bearing challenge token when enrolled 2FA must complete before code issuance',
      twofa_enroll_required:
        'true when effective policy requires enrollment before the scoped code can be issued',
      setup_token:
        'team-bearing setup token when twofa_enroll_required is true (alongside QR/manual setup fields)',
      'login_token?':
        'short-lived bridge JWT (only when the chooser gate passes) — authorizes ONLY POST /auth/select-team for this verified user',
      'teams?':
        'array of { teamId, orgId, name, slug, role, iconUrl, avatarImageUrl, orgName, orgSlug } (only with login_token). avatarImageUrl is the public /teams/:teamId/avatar form (never null, no credential needed); orgName is the owning organisation, so same-named teams in different orgs stay distinguishable',
      'pending_invites?': 'array of { inviteId, teamName, invitedBy } (only with login_token)',
      'can_create_org?': 'boolean (only with login_token)',
      'creatable_orgs?':
        'array of { orgId, orgName } — organisations this user may add a team to via POST /auth/create-team (ACTIVE owner/admin there + org_features.allow_user_create_team). Empty unless the domain opted in. Distinct from can_create_org, which permits creating a new organisation',
    },
  },
  authTokenEndpoint,
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
    description:
      'Email registration/login link landing. A direct password invitation without PKCE opens account creation with the invitation email fixed in a read-only field; the invitation token, not that field, remains authoritative. An invitation for an address that already has an account carries a LOGIN_LINK token and likewise arrives without PKCE: it is accepted here and answered with a terminal confirmation page, because there is no code verifier to end in an authorization code and a login restart would drop the invitation. A refused acceptance (revoked, expired, already used, conflicting) answers 400 with the same unavailable page as the invitation landing, never a login form. For a non-invite link with config.login_flow.team_selection="auto", 2+ ACTIVE teams, a pending invite, or zero teams with can_create_org redirect to the team chooser; exactly one ACTIVE team/no invite is selected server-side and carried through applicable 2FA into the code. Invite-bound links carry the accepted invite orgId/teamId through the same 2FA/code/token pipeline without showing the chooser. team_selection="off" leaves legacy clients unscoped, but a recognized product pre-binds one exact team before 2FA without showing the chooser.',
    query: {
      state:
        'string (optional, ≤2048) — opaque relying-party CSRF value. UOA does not interpret it; it is bound to this login (login_token, 2FA bridge, social state) and echoed verbatim beside `code` on the final redirect, and beside `error` on a failed social callback. Later hops must not re-supply it: a hop presenting a different value is refused.',
      token: 'string (required)',
      config_url: 'string (required)',
      redirect_url: 'string (optional)',
      code_challenge:
        'string (optional for recovery; required to complete the one-click OAuth grant) — exactly 43-char PKCE S256 challenge preserved through email verification',
      code_challenge_method: '"S256" when code_challenge is sent',
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
    path: '/auth/team-invite-link/:token',
    description:
      'Shareable team invite-link landing page. Public, IP-rate-limited, no auth. Validates the token WITHOUT redeeming it or granting any membership (unknown/revoked/expired/over-cap/HIDDEN all render the same generic invalid-link page). A valid token renders the normal Auth UI bootstrapped to start email verification, carrying invite_link_token for the client to pass into POST /auth/select-team once identity is verified.',
    query: {
      config_url: 'string (required)',
      redirect_url: 'string (optional)',
    },
  },
  {
    method: 'GET',
    path: '/auth/social/:provider',
    description:
      'Initiate social OAuth flow (google, facebook, github, linkedin, apple). Sets a signed, HttpOnly `uoa_social_state` cookie (SameSite=Lax, Path=/auth) that binds the OAuth `state` to the browser; the cookie must be returned to /auth/callback. A direct team invitation may use invite_token without PKCE; its raw capability is retained only in a second signed HttpOnly cookie and never placed in provider-visible state.',
    query: {
      state:
        'string (optional, ≤2048) — opaque relying-party CSRF value. UOA does not interpret it; it is bound to this login (login_token, 2FA bridge, social state) and echoed verbatim beside `code` on the final redirect, and beside `error` on a failed social callback. Later hops must not re-supply it: a hop presenting a different value is refused.',
      config_url: 'string (required)',
      redirect_url: 'string (optional)',
      code_challenge:
        'string (required except a direct live team invitation) — exactly 43-char PKCE S256 challenge',
      code_challenge_method: '"S256" (required whenever code_challenge is sent)',
      request_access:
        'string (optional) — routes social auth through configured-team access policy',
      invite_token:
        'string (optional) — direct team invitation capability. The provider-verified email must exactly match the invite email; otherwise authentication is rejected.',
    },
  },
  {
    method: 'GET',
    path: '/auth/callback/:provider',
    description:
      'OAuth provider callback. Requires the signed `uoa_social_state` cookie set at /auth/social to match the nonce embedded in `state` (login-CSRF protection); the cookie is single-use and cleared on consume. A direct invitation also requires its signed HttpOnly invite-capability cookie and an exact match between its live invitation email and the provider-verified email; it accepts the invite without issuing an OAuth code. With team_selection="auto", team is resolved before 2FA: 2+ ACTIVE teams, any pending invite, or zero teams with can_create_org redirect with a login_token chooser bridge, while exactly one ACTIVE team/no invite is selected server-side and its exact orgId/teamId survives any 2FA challenge or enrollment token into the authorization code and active token claim. team_selection="off" leaves legacy clients unscoped; recognized products suppress the chooser but pre-bind their exact team before 2FA.',
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
      setup_token:
        'string (required) — short-lived setup token from /2fa/setup or login enforcement',
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
