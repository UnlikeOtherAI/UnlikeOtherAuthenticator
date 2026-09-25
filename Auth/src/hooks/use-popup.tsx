import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';

import type { TranslationKey } from '../i18n/translations/en.js';
import { parsePopupQueryParams, type PopupQueryParams } from './popup-query-params.js';

export { parsePopupQueryParams, type PopupQueryParams } from './popup-query-params.js';

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
  /**
   * The inviting organisation's name. Optional so a payload minted before the field existed still
   * parses; when it is there the card names it, because an invitation can come from an
   * organisation this person has no team in at all and two organisations can each own a
   * "General".
   */
  orgName?: string | null;
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
      ['invite_name', parsed.inviteName],
    ];
    const present = bridgeParams.filter(([, token]) => token);
    if (present.length === 0) return;
    const url = new URL(window.location.href);
    if (present.some(([param, token]) => url.searchParams.get(param) !== token)) return;
    for (const [param] of present) url.searchParams.delete(param);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [
    parsed.inviteEmail,
    parsed.inviteName,
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
      inviteName: parsed.inviteName,
      inviteAccepted: parsed.inviteAccepted,
      clientId: parsed.clientId,
      nativeSocialComplete: parsed.nativeSocialComplete,
      nativeFlowId: parsed.nativeFlowId,
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
    parsed.inviteName,
    parsed.inviteAccepted,
    parsed.clientId,
    parsed.nativeSocialComplete,
    parsed.nativeFlowId,
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
