import React, { createContext, useContext, useMemo, useState, useCallback } from 'react';

export type AuthView =
  | 'login'
  | 'register'
  | 'reset-password'
  | 'set-password'
  | 'access-requested'
  | 'signed-in'
  | 'code-entry'
  | 'workspace-chooser';

export type TwoFactorSetupState = {
  setup_token: string;
  otpauth_uri?: string;
  qr_svg?: string;
  manual_secret?: string;
};

/** Phase 3c (design §11.2): a single ACTIVE workspace membership offered by the chooser. */
export type TeamChoice = {
  teamId: string;
  orgId: string;
  name: string;
  role: string;
  iconUrl?: string | null;
};

/** Phase 3c (design §11.2): a pending team invite offered alongside the chooser. */
export type InviteChoice = {
  inviteId: string;
  teamName: string;
  invitedBy?: string | null;
};

/** Mirrors `buildWorkspaceChoices` (API `first-login.service.ts`) field-for-field. */
export type WorkspaceChoices = {
  teams: TeamChoice[];
  pending_invites: InviteChoice[];
  can_create_org: boolean;
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
  /** Public-client / MCP profile (brief §22.14): present only on /oauth/authorize. */
  clientId: string | null;
  state: string | null;
  resource: string | null;
  /**
   * Native deep-link target the flow should hand off to (custom scheme). When present, the
   * auth window renders the "signed in — return to the app" handoff view instead of bouncing
   * straight to the scheme, so the browser tab isn't left blank.
   */
  handoffTarget: string | null;
  /**
   * Phase 3c follow-up (design §4.3 Task 7 remainder): the `login_token` bridge seeded via a
   * redirect (currently: the social callback's workspace_chooser branch), only ever set alongside
   * `flow=workspace_chooser`. Unlike `twofa_token`, the chooser payload itself doesn't fit in the
   * URL — the SPA hydrates it afterwards via `POST /auth/session-choices`.
   */
  loginToken: string | null;
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
   * `login_token`/`flow=workspace_chooser` query pair seeded by the social callback (declared on
   * `PopupQueryParams` above so it can be parsed from the URL like `twoFaToken`).
   */
  setLoginToken: (token: string | null) => void;
  /** The workspace chooser payload for the current `loginToken`. */
  workspaceChoices: WorkspaceChoices | null;
  setWorkspaceChoices: (choices: WorkspaceChoices | null) => void;
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
      clientId: null,
      state: null,
      resource: null,
      handoffTarget: null,
      loginToken: null,
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
  const rawType = params.get('email_token_type');
  const clientId = params.get('client_id');
  const state = params.get('state');
  const resource = params.get('resource');
  const handoffTarget = params.get('handoff_target');
  // Phase 3c follow-up (design §4.3 Task 7 remainder): only trust `login_token` when the redirect
  // also carries the `flow=workspace_chooser` marker — mirrors how `twofa_token` is scoped by its
  // own dedicated query param, so a stray `login_token` on an unrelated redirect is never picked up.
  const loginToken =
    params.get('flow') === 'workspace_chooser' ? params.get('login_token') : null;

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
    clientId: clientId && clientId.trim() ? clientId : null,
    state: state && state.trim() ? state : null,
    resource: resource && resource.trim() ? resource : null,
    handoffTarget: handoffTarget && handoffTarget.trim() ? handoffTarget : null,
    loginToken: loginToken && loginToken.trim() ? loginToken : null,
  };
}

function readClientSearch(): string {
  if (typeof window === 'undefined') return '';
  return window.location?.search ?? '';
}

function deriveInitialView(parsed: PopupQueryParams): AuthView {
  if (parsed.handoffTarget) {
    // Server-rendered handoff (e.g. social callback to a native deep link).
    return 'signed-in';
  }
  if (parsed.requestAccessStatus === 'pending') {
    return 'access-requested';
  }
  if (parsed.loginToken) {
    // Phase 3c follow-up (design §4.3 Task 7 remainder): the social callback seeded a login_token
    // bridge via redirect. WorkspaceChooserPage hydrates workspaceChoices itself on mount.
    return 'workspace-chooser';
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
   * URL — they're set by `setPendingEmail`/`setLoginToken`/`setWorkspaceChoices` as the flow
   * progresses — but exposing them as optional props lets callers (tests, storybook-style
   * harnesses) construct a provider already positioned at a given step.
   */
  initialView?: AuthView;
  initialPendingEmail?: string | null;
  initialLoginToken?: string | null;
  initialWorkspaceChoices?: WorkspaceChoices | null;
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
  // Phase 3c (design §11.2): client-held state for the code-entry + workspace-chooser steps.
  const [pendingEmail, setPendingEmailState] = useState<string | null>(
    () => props.initialPendingEmail ?? null,
  );
  const [loginToken, setLoginTokenState] = useState<string | null>(
    () => props.initialLoginToken ?? parsed.loginToken,
  );
  const [workspaceChoices, setWorkspaceChoicesState] = useState<WorkspaceChoices | null>(
    () => props.initialWorkspaceChoices ?? null,
  );

  const setView = useCallback((v: AuthView) => setViewState(v), []);
  const setPendingEmail = useCallback((email: string | null) => setPendingEmailState(email), []);
  const setLoginToken = useCallback((token: string | null) => setLoginTokenState(token), []);
  const setWorkspaceChoices = useCallback(
    (choices: WorkspaceChoices | null) => setWorkspaceChoicesState(choices),
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
      clientId: parsed.clientId,
      state: parsed.state,
      resource: parsed.resource,
      handoffTarget,
      view,
      setView,
      startTwoFactorVerify,
      startTwoFactorSetup,
      twoFactorSetup,
      pendingEmail,
      setPendingEmail,
      loginToken,
      setLoginToken,
      workspaceChoices,
      setWorkspaceChoices,
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
    parsed.clientId,
    parsed.state,
    parsed.resource,
    handoffTarget,
    view,
    setView,
    startTwoFactorVerify,
    startTwoFactorSetup,
    twoFactorSetup,
    pendingEmail,
    setPendingEmail,
    loginToken,
    setLoginToken,
    workspaceChoices,
    setWorkspaceChoices,
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
