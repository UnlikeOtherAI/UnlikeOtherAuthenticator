/**
 * The auth window's query string, parsed once into the values the popup context exposes.
 *
 * Kept apart from the context provider in `use-popup.tsx`: this is pure parsing with no React,
 * and every flow that adds a URL-carried value (bridge tokens, invitation fields) grows it.
 */

export type PopupQueryParams = {
  redirectUrl: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: 'S256' | null;
  twoFaToken: string | null;
  twoFaSetupToken: string | null;
  requestAccess: boolean;
  requestAccessStatus: 'pending' | null;
  /** Token from an email link landing (registration verify or password reset). */
  emailToken: string | null;
  /** The type of email link flow, set by the server on landing routes. */
  emailTokenType: 'VERIFY_EMAIL_SET_PASSWORD' | 'VERIFY_EMAIL' | 'LOGIN_LINK' | 'PASSWORD_RESET' | null;
  /** One-time capability for a team invitation account-creation flow. */
  inviteToken: string | null;
  /** The invitee address displayed as a locked, non-editable field. */
  inviteEmail: string | null;
  /** The name the inviter gave, pre-filled into the editable "Your name" field. */
  inviteName: string | null;
  /** Server-set marker after a direct social invitation has been accepted. */
  inviteAccepted: boolean;
  /** Public-client / MCP profile (brief §22.14): present only on /oauth/authorize. */
  clientId: string | null;
  state: string | null;
  resource: string | null;
  scope: string | null;
  /** Short-lived opaque capability for an authenticated agreement-signing continuation. */
  signingToken: string | null;
  /**
   * Native deep-link target the flow should hand off to (custom scheme). When present, the
   * auth window renders the "signed in — return to the app" handoff view instead of bouncing
   * straight to the scheme, so the browser tab isn't left blank.
   */
  handoffTarget: string | null;
  /**
   * Phase 3c follow-up (design §4.3 Task 7 remainder): the `login_token` bridge seeded via a
   * redirect (currently: the social callback's team_chooser branch), only ever set alongside
   * `flow=team_chooser`. Unlike `twofa_token`, the chooser payload itself doesn't fit in the
   * URL — the SPA hydrates it afterwards via `POST /auth/session-choices`.
   */
  loginToken: string | null;
  /**
   * Gap-fix B Task 2 (design §11.4): a deep-link/switch preselect — "jump straight into this
   * team" from a product's sidebar (`GET /auth?...&team_hint=<teamId|slug>`). Client-side
   * ONLY: it may only cause auto-selection of a team already present in the verified user's own
   * chooser payload (`TeamChooserPage`'s hint-match), never anything wider — `select-team`'s
   * server-side ACTIVE-membership + domain check remains the sole authority.
   */
  teamHint: string | null;
};

function normalizeSearch(value: string): string {
  if (!value) return '';
  return value.startsWith('?') ? value : `?${value}`;
}

export function parsePopupQueryParams(search: string): PopupQueryParams {
  const s = normalizeSearch(search);
  if (!s) {
    return {
      redirectUrl: null,
      codeChallenge: null,
      codeChallengeMethod: null,
      twoFaToken: null,
      twoFaSetupToken: null,
      requestAccess: false,
      requestAccessStatus: null,
      emailToken: null,
      emailTokenType: null,
      inviteToken: null,
      inviteEmail: null,
      inviteName: null,
      inviteAccepted: false,
      clientId: null,
      state: null,
      resource: null,
      scope: null,
      signingToken: null,
      handoffTarget: null,
      loginToken: null,
      teamHint: null,
    };
  }

  const params = new URLSearchParams(s);

  const redirectUrl = params.get('redirect_url') ?? params.get('redirect_uri');
  const codeChallenge = params.get('code_challenge');
  const codeChallengeMethod = params.get('code_challenge_method');
  const twoFaToken = params.get('twofa_token');
  const twoFaSetupToken = params.get('twofa_setup_token');
  const requestAccess = ['1', 'true', 'yes'].includes((params.get('request_access') ?? '').toLowerCase());
  const requestAccessStatus = params.get('request_access_status') === 'pending' ? 'pending' : null;
  const emailToken = params.get('email_token');
  const inviteToken = params.get('invite_token');
  const inviteEmail = params.get('invite_email');
  const inviteName = params.get('invite_name');
  const rawType = params.get('email_token_type');
  const clientId = params.get('client_id');
  const state = params.get('state');
  const resource = params.get('resource');
  const scope = params.get('scope');
  const signingToken =
    params.get('flow') === 'signatures' ? params.get('signing_token') : null;
  const handoffTarget = params.get('handoff_target');
  // Phase 3c follow-up (design §4.3 Task 7 remainder): only trust `login_token` when the redirect
  // also carries the `flow=team_chooser` marker — mirrors how `twofa_token` is scoped by its
  // own dedicated query param, so a stray `login_token` on an unrelated redirect is never picked up.
  const loginToken =
    params.get('flow') === 'team_chooser' ? params.get('login_token') : null;
  // Gap-fix B Task 2 (design §11.4): a deep-link/switch chooser preselect. Parsed unconditionally
  // (unlike `login_token`, it isn't scoped to another marker param) — validity/membership is
  // re-checked against the verified user's own chooser payload before it can select anything.
  const teamHint = params.get('team_hint');
  const inviteAccepted = params.get('flow') === 'invite_accepted';

  const validTypes = ['VERIFY_EMAIL_SET_PASSWORD', 'VERIFY_EMAIL', 'LOGIN_LINK', 'PASSWORD_RESET'] as const;
  const emailTokenType = rawType && (validTypes as readonly string[]).includes(rawType)
    ? (rawType as PopupQueryParams['emailTokenType'])
    : null;

  return {
    redirectUrl: redirectUrl && redirectUrl.trim() ? redirectUrl : null,
    codeChallenge: codeChallenge && codeChallenge.trim() ? codeChallenge : null,
    codeChallengeMethod: codeChallengeMethod === 'S256' ? 'S256' : null,
    twoFaToken: twoFaToken && twoFaToken.trim() ? twoFaToken : null,
    twoFaSetupToken: twoFaSetupToken && twoFaSetupToken.trim() ? twoFaSetupToken : null,
    requestAccess,
    requestAccessStatus,
    emailToken: emailToken && emailToken.trim() ? emailToken : null,
    emailTokenType,
    inviteToken: inviteToken && inviteToken.trim() ? inviteToken : null,
    inviteEmail: inviteEmail && inviteEmail.trim() ? inviteEmail : null,
    inviteName: inviteName && inviteName.trim() ? inviteName.trim() : null,
    inviteAccepted,
    clientId: clientId && clientId.trim() ? clientId : null,
    state: state && state.trim() ? state : null,
    resource: resource && resource.trim() ? resource : null,
    scope: scope && scope.trim() ? scope : null,
    signingToken: signingToken && signingToken.trim() ? signingToken : null,
    handoffTarget: handoffTarget && handoffTarget.trim() ? handoffTarget : null,
    loginToken: loginToken && loginToken.trim() ? loginToken : null,
    teamHint: teamHint && teamHint.trim() ? teamHint : null,
  };
}
