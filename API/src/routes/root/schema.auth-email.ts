import type { EndpointSchema } from './schema.js';

/**
 * The mail-bound landings: password reset, 2FA reset, the registration/login link, and the
 * team-invitation pages. Split out of `schema.auth.ts` to keep both files under the 500-line
 * limit; `authEndpoints` still splices them in at the same position, so `GET /api` is unchanged.
 */
export const authEmailEndpoints: EndpointSchema[] = [
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
      'Email registration/login link landing. A direct password invitation without PKCE opens account creation with the invitation email fixed in a read-only field; the invitation token, not that field, remains authoritative. An invitation for an address that already has an account carries a LOGIN_LINK token and likewise arrives without PKCE: it is accepted here and answered with a terminal confirmation page, because there is no code verifier to end in an authorization code and a login restart would drop the invitation. A refused invitation acceptance answers 400 rather than showing a login form: an elapsed invite/token deadline renders Invitation expired, while revoked, used, conflicting, and every other unusable state render Invitation invalid. For a non-invite link with config.login_flow.team_selection="auto", 2+ ACTIVE teams, a pending invite, or zero teams with can_create_org redirect to the team chooser; exactly one ACTIVE team/no invite is selected server-side and carried through applicable 2FA into the code. Invite-bound links carry the accepted invite orgId/teamId through the same 2FA/code/token pipeline without showing the chooser. team_selection="off" leaves legacy clients unscoped, but a recognized product pre-binds one exact team before 2FA without showing the chooser.',
    query: {
      state:
        'string (optional, ≤2048) — opaque relying-party CSRF value. UOA does not interpret it; it is bound to this login (login_token, 2FA bridge, social state) and echoed verbatim beside `code` on the final redirect, and beside `error` on a failed social callback. Later hops must not re-supply it: a hop presenting a different value is refused.',
      token: 'string (required)',
      config_url: 'string (required)',
      redirect_url:
        'string (optional) — must be one of config.redirect_urls. On an invitation terminal page it also becomes a "Continue to <product>" link (product name from ui_theme.logo.alt, else the config domain) and rides the invite-registration continuation so the hosted "Invitation accepted" view offers the same link. A value not in config.redirect_urls is dropped: the page renders exactly as it does without the parameter.',
      code_challenge:
        'string (optional for recovery; required to complete the one-click OAuth grant) — exactly 43-char PKCE S256 challenge preserved through email verification',
      code_challenge_method: '"S256" when code_challenge is sent',
      request_access: 'string (optional) — preserves access-request intent through email auth',
    },
  },
  {
    method: 'GET',
    path: '/auth/email/team-invite',
    description:
      'Team invite landing page with accept/decline actions. Emailed invitations are valid for 24 hours. An elapsed invitation or email-token deadline renders Invitation expired; every other unusable state renders Invitation invalid.',
    query: {
      token: 'string (required)',
      config_url: 'string (required)',
      redirect_url:
        'string (optional) — carried onto the Accept action so the terminal page can offer a "Continue to <product>" link. Only honoured when it is one of config.redirect_urls.',
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
];
