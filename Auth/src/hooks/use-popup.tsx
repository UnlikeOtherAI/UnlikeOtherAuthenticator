import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';

import type { TranslationKey } from '../i18n/translations/en.js';

export type AuthView =
  | 'login'
  | 'register'
  | 'reset-password'
  | 'set-password'
  | 'invite-registration'
  | 'invite-accepted'
  | 'access-requested'
  | 'signed-in'
  | 'signatures'
  | 'code-entry'
  | 'team-chooser';

export type TwoFactorSetupState = {
  setup_token: string;
  otpauth_uri?: string;
  qr_svg?: string;
  manual_secret?: string;
};

/** Phase 3c (design §11.2): a single ACTIVE team membership offered by the chooser. */
export type TeamChoice = {
  teamId: string;
  orgId: string;
  name: string;
  role: string;
  iconUrl?: string | null;
  /**
   * Always-resolving team image (Docs/Auth/avatars.md §11.4): the credential-free
   * `/teams/:teamId/avatar` form, the only one this popup can put in an `<img src>`. Optional so a
   * payload minted before the field existed still parses; the card falls back accordingly.
   */
  avatarImageUrl?: string | null;
  /** The owning organisation's name — two orgs can each have a team called "General". */
  orgName?: string;
  /** Gap-fix B (design §11.4): lets a `team_hint` deep-link match by slug as well as by id. */
  slug?: string;
};

/**
 * An organisation this user may add a team to (`creatable_orgs`): they are an ACTIVE
 * owner/admin of it and the domain enabled `org_features.allow_user_create_team`. The chooser
 * presents these server-authorized targets in its creation-dialog destination selector.
 */
export type CreatableOrgChoice = {
  orgId: string;
  orgName: string;
};

/** Phase 3c (design §11.2): a pending team invite offered alongside the chooser. */
export type InviteChoice = {
  inviteId: string;
  teamName: string;
  invitedBy?: string | null;
};

/** Mirrors `buildSessionChoices` (API `first-login.service.ts`) field-for-field. */
export type SessionChoices = {
  teams: TeamChoice[];
  pending_invites: InviteChoice[];
  can_create_org: boolean;
  creatable_orgs: CreatableOrgChoice[];
};

/** True for a native deep-link target (custom scheme, not http/https). */
function isCustomSchemeUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol !== 'http:' && protocol !== 'https:';
  } catch {
    return false;
  }
}

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

export type PopupContextValue = PopupQueryParams & {
  configUrl: string;
  /** The raw client config object (for reading enabled_auth_methods, etc.). */
  config: unknown;
  /** Current auth view. */
  view: AuthView;
  /** Navigate between auth views. */
  setView: (view: AuthView) => void;
  startTwoFactorVerify: (token: string) => void;
  startTwoFactorSetup: (setup: TwoFactorSetupState) => void;
  twoFactorSetup: TwoFactorSetupState | null;
  /** The email a sign-in code was sent to (email-code and code-entry flow). */
  pendingEmail: string | null;
  setPendingEmail: (email: string | null) => void;
  /**
   * Bridge token from /auth/verify-code, a chooser-producing /auth/login (design §4.3), or the
   * `login_token`/`flow=team_chooser` query pair seeded by the social callback (declared on
   * `PopupQueryParams` above so it can be parsed from the URL like `twoFaToken`).
   */
  setLoginToken: (token: string | null) => void;
  /**
   * A one-shot i18n key explaining why the popup moved the user somewhere they did not click to —
   * currently only an expired login bridge sending them back to sign in. The view that renders it
   * clears it, so it never survives into a later step.
   */
  notice: TranslationKey | null;
  setNotice: (key: TranslationKey | null) => void;
  /** The team chooser payload for the current `loginToken`. */
  teamChoices: SessionChoices | null;
  setSessionChoices: (choices: SessionChoices | null) => void;
  /**
   * Perform the final OAuth redirect (authorization code flow).
   * This intentionally uses a normal top-level navigation, not postMessage.
   */
  redirectTo: (url: string) => void;
};

const PopupContext = createContext<PopupContextValue | null>(null);

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

function readClientSearch(): string {
  if (typeof window === 'undefined') return '';
  return window.location?.search ?? '';
}

function deriveInitialView(parsed: PopupQueryParams): AuthView {
  if (parsed.signingToken) {
    return 'signatures';
  }
  if (parsed.handoffTarget) {
    // Server-rendered handoff (e.g. social callback to a native deep link).
    return 'signed-in';
  }
  if (parsed.requestAccessStatus === 'pending') {
    return 'access-requested';
  }
  if (parsed.inviteAccepted) {
    return 'invite-accepted';
  }
  if (parsed.inviteToken && parsed.inviteEmail) {
    return 'invite-registration';
  }
  if (parsed.loginToken) {
    // Phase 3c follow-up (design §4.3 Task 7 remainder): the social callback seeded a login_token
    // bridge via redirect. TeamChooserPage hydrates teamChoices itself on mount.
    return 'team-chooser';
  }
  if (parsed.emailToken && parsed.emailTokenType) {
    // Email link landing: show set-password for both registration+password and password reset.
    if (parsed.emailTokenType === 'VERIFY_EMAIL_SET_PASSWORD' || parsed.emailTokenType === 'PASSWORD_RESET') {
      return 'set-password';
    }
    // VERIFY_EMAIL and LOGIN_LINK are handled by auto-submission on the server; shouldn't reach here,
    // but default to login if they do.
  }
  return 'login';
}

export function PopupProvider(props: {
  configUrl: string;
  config?: unknown;
  initialSearch?: string;
  /**
   * Seed values for the client-held chooser state (Phase 3c). These never come from the
   * URL — they're set by `setPendingEmail`/`setLoginToken`/`setSessionChoices` as the flow
   * progresses — but exposing them as optional props lets callers (tests, storybook-style
   * harnesses) construct a provider already positioned at a given step.
   */
  initialView?: AuthView;
  initialPendingEmail?: string | null;
  initialLoginToken?: string | null;
  initialSessionChoices?: SessionChoices | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const [search] = useState(() => {
    // Keep the initial value stable for SSR hydration.
    return props.initialSearch ?? readClientSearch();
  });

  const parsed = useMemo(() => parsePopupQueryParams(search), [search]);
  const [view, setViewState] = useState<AuthView>(() => props.initialView ?? deriveInitialView(parsed));
  const [twoFaToken, setTwoFaToken] = useState<string | null>(() => parsed.twoFaToken);
  const [twoFactorSetup, setTwoFactorSetup] = useState<TwoFactorSetupState | null>(() =>
    parsed.twoFaSetupToken ? { setup_token: parsed.twoFaSetupToken } : null,
  );
  // Seeded from the query for the server-rendered handoff; updated by redirectTo for the
  // client-side flows (email/password, 2FA, verify-email) when the target is a custom scheme.
  const [handoffTarget, setHandoffTarget] = useState<string | null>(() => parsed.handoffTarget);
  // Phase 3c (design §11.2): client-held state for the code-entry + team-chooser steps.
  const [pendingEmail, setPendingEmailState] = useState<string | null>(
    () => props.initialPendingEmail ?? null,
  );
  const [loginToken, setLoginTokenState] = useState<string | null>(
    () => props.initialLoginToken ?? parsed.loginToken,
  );
  const [teamChoices, setSessionChoicesState] = useState<SessionChoices | null>(
    () => props.initialSessionChoices ?? null,
  );
  const [notice, setNotice] = useState<TranslationKey | null>(null);

  useEffect(() => {
    if (!parsed.signingToken || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('signing_token') !== parsed.signingToken) return;
    url.searchParams.delete('signing_token');
    if (url.searchParams.get('flow') === 'signatures') url.searchParams.delete('flow');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [parsed.signingToken]);

  // Same cleanup for the sibling bridge tokens: once read into React state they must not
  // linger in window.location.search (browser history, screenshots, screen shares).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const bridgeParams: Array<[string, string | null]> = [
      ['login_token', parsed.loginToken],
      ['twofa_token', parsed.twoFaToken],
      ['twofa_setup_token', parsed.twoFaSetupToken],
      ['invite_token', parsed.inviteToken],
      ['invite_email', parsed.inviteEmail],
    ];
    const present = bridgeParams.filter(([, token]) => token);
    if (present.length === 0) return;
    const url = new URL(window.location.href);
    if (present.some(([param, token]) => url.searchParams.get(param) !== token)) return;
    for (const [param] of present) url.searchParams.delete(param);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [
    parsed.inviteEmail,
    parsed.inviteToken,
    parsed.loginToken,
    parsed.twoFaToken,
    parsed.twoFaSetupToken,
  ]);

  // Navigating clears any notice, so a reason for landing somewhere cannot leak into a later step
  // the user walked to themselves. The expired-bridge path therefore sets its notice AFTER the
  // view change, not before.
  const setView = useCallback((v: AuthView) => {
    setNotice(null);
    setViewState(v);
  }, []);
  const setPendingEmail = useCallback((email: string | null) => setPendingEmailState(email), []);
  const setLoginToken = useCallback((token: string | null) => setLoginTokenState(token), []);
  const setSessionChoices = useCallback(
    (choices: SessionChoices | null) => setSessionChoicesState(choices),
    [],
  );
  const startTwoFactorVerify = useCallback((token: string) => {
    setTwoFaToken(token);
    setViewState('login');
  }, []);
  const startTwoFactorSetup = useCallback((setup: TwoFactorSetupState) => {
    setTwoFactorSetup(setup);
    setViewState('login');
  }, []);

  const value = useMemo<PopupContextValue>(() => {
    return {
      configUrl: props.configUrl,
      config: props.config,
      redirectUrl: parsed.redirectUrl,
      codeChallenge: parsed.codeChallenge,
      codeChallengeMethod: parsed.codeChallengeMethod,
      twoFaToken,
      twoFaSetupToken: parsed.twoFaSetupToken,
      requestAccess: parsed.requestAccess,
      requestAccessStatus: parsed.requestAccessStatus,
      emailToken: parsed.emailToken,
      emailTokenType: parsed.emailTokenType,
      inviteToken: parsed.inviteToken,
      inviteEmail: parsed.inviteEmail,
      inviteAccepted: parsed.inviteAccepted,
      clientId: parsed.clientId,
      state: parsed.state,
      resource: parsed.resource,
      scope: parsed.scope,
      signingToken: parsed.signingToken,
      handoffTarget,
      teamHint: parsed.teamHint,
      view,
      setView,
      startTwoFactorVerify,
      startTwoFactorSetup,
      twoFactorSetup,
      pendingEmail,
      setPendingEmail,
      loginToken,
      setLoginToken,
      notice,
      setNotice,
      teamChoices,
      setSessionChoices,
      redirectTo: (url: string) => {
        if (typeof window === 'undefined') return;
        // Native deep links (custom schemes) launch the OS handler without unloading this
        // tab, so a bare assign would leave the user staring at a blank page. Render the
        // handoff view instead — it fires the launch and tells them they can close the tab.
        if (isCustomSchemeUrl(url)) {
          setHandoffTarget(url);
          setView('signed-in');
          return;
        }
        window.location.assign(url);
      },
    };
  }, [
    parsed.redirectUrl,
    parsed.codeChallenge,
    parsed.codeChallengeMethod,
    twoFaToken,
    parsed.twoFaSetupToken,
    parsed.requestAccess,
    parsed.requestAccessStatus,
    parsed.emailToken,
    parsed.emailTokenType,
    parsed.inviteToken,
    parsed.inviteEmail,
    parsed.inviteAccepted,
    parsed.clientId,
    parsed.state,
    parsed.resource,
    parsed.scope,
    parsed.signingToken,
    handoffTarget,
    parsed.teamHint,
    view,
    setView,
    startTwoFactorVerify,
    startTwoFactorSetup,
    twoFactorSetup,
    pendingEmail,
    setPendingEmail,
    loginToken,
    setLoginToken,
    notice,
    teamChoices,
    setSessionChoices,
    props.configUrl,
    props.config,
  ]);

  return <PopupContext.Provider value={value}>{props.children}</PopupContext.Provider>;
}

export function usePopup(): PopupContextValue {
  const ctx = useContext(PopupContext);
  if (!ctx) throw new Error('usePopup must be used within <PopupProvider />');
  return ctx;
}
