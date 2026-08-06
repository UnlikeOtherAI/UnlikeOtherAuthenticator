import type { TranslationKey } from '../i18n/translations/en.js';
import type {
  AuthView,
  CreatableOrgChoice,
  InviteChoice,
  TeamChoice,
  TwoFactorSetupState,
  WorkspaceChoices,
} from '../hooks/use-popup.js';

/**
 * Phase 3c (design §11.2): `/auth/verify-code`, `/auth/select-team`, and a chooser-producing
 * `/auth/login` all resolve to one of the same four shapes. This is the single place that reads
 * the raw JSON and decides what the popup should do next — shared by `CodeEntryPage`,
 * `LoginForm`, and every workspace-chooser card so the branching logic only lives once.
 */
export type WorkspaceResponseOutcome =
  | { kind: 'chooser'; loginToken: string; choices: WorkspaceChoices }
  | { kind: 'redirect'; url: string }
  | { kind: 'twofa'; token: string }
  | { kind: 'twofa_enroll'; setup: TwoFactorSetupState }
  /**
   * The login bridge is gone — expired, already spent, or minted for another continuation. The
   * chooser cannot recover from this: `login_token` is one-time and short-lived, so every card on
   * the screen would fail the same way. Distinct from `error` precisely so the caller sends the
   * user back to sign in instead of offering a retry that cannot succeed.
   */
  | { kind: 'expired' }
  | { kind: 'error' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toTeamChoices(value: unknown): TeamChoice[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is TeamChoice =>
      isRecord(v) &&
      typeof v.teamId === 'string' &&
      typeof v.orgId === 'string' &&
      typeof v.name === 'string' &&
      typeof v.role === 'string',
  );
}

function toCreatableOrgs(value: unknown): CreatableOrgChoice[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is CreatableOrgChoice =>
      isRecord(v) && typeof v.orgId === 'string' && typeof v.orgName === 'string',
  );
}

function toInviteChoices(value: unknown): InviteChoice[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is InviteChoice =>
      isRecord(v) && typeof v.inviteId === 'string' && typeof v.teamName === 'string',
  );
}

/**
 * The API folds every login-session rejection into one generic 401 (no enumeration), so the status
 * is all the client gets — and all it needs: on these routes a 401 can only mean the bridge this
 * page holds is no longer good for anything.
 */
export function isExpiredBridge(status: number): boolean {
  return status === 401;
}

/** Reads a raw `/auth/*` flow response and decides which client step comes next. */
export function interpretWorkspaceResponse(data: unknown): WorkspaceResponseOutcome {
  if (!isRecord(data)) return { kind: 'error' };

  // Chooser payload (design §4.3): no `ok` field, but a bridge `login_token` plus the choices.
  if (typeof data.login_token === 'string' && Array.isArray(data.teams)) {
    return {
      kind: 'chooser',
      loginToken: data.login_token,
      choices: {
        teams: toTeamChoices(data.teams),
        pending_invites: toInviteChoices(data.pending_invites),
        can_create_org: Boolean(data.can_create_org),
        creatable_orgs: toCreatableOrgs(data.creatable_orgs),
      },
    };
  }

  if (data.twofa_required === true && typeof data.twofa_token === 'string') {
    return { kind: 'twofa', token: data.twofa_token };
  }

  if (data.twofa_enroll_required === true && typeof data.setup_token === 'string') {
    return {
      kind: 'twofa_enroll',
      setup: {
        setup_token: data.setup_token,
        otpauth_uri: typeof data.otpauth_uri === 'string' ? data.otpauth_uri : undefined,
        qr_svg: typeof data.qr_svg === 'string' ? data.qr_svg : undefined,
        manual_secret: typeof data.manual_secret === 'string' ? data.manual_secret : undefined,
      },
    };
  }

  if (typeof data.redirect_to === 'string') {
    return { kind: 'redirect', url: data.redirect_to };
  }

  return { kind: 'error' };
}

/**
 * Phase 3c follow-up (design §4.3 Task 7 remainder): decode a raw `POST /auth/session-choices`
 * response — the bare `{ teams, pending_invites, can_create_org }` shape (no `login_token`, unlike
 * the chooser-producing endpoints, since the caller already holds one) — into `WorkspaceChoices`.
 * Returns null for anything that doesn't look like a valid payload (generic failure upstream).
 */
export function toWorkspaceChoices(data: unknown): WorkspaceChoices | null {
  if (!isRecord(data) || !Array.isArray(data.teams)) return null;
  return {
    teams: toTeamChoices(data.teams),
    pending_invites: toInviteChoices(data.pending_invites),
    can_create_org: Boolean(data.can_create_org),
    creatable_orgs: toCreatableOrgs(data.creatable_orgs),
  };
}

/**
 * Design §11.2: "the chooser is skipped automatically ... when the user has exactly one active
 * team and no pending invites." Returns the team to auto-select, or null when the chooser should
 * render normally.
 */
export function pickAutoSkipTeam(choices: WorkspaceChoices): TeamChoice | null {
  if (choices.teams.length === 1 && choices.pending_invites.length === 0) {
    return choices.teams[0] ?? null;
  }
  return null;
}

/**
 * Gap-fix B Task 2 (design §11.4): `team_hint` deep-link/switch preselect. Matches by `teamId` OR
 * `slug` — but ONLY against a team already present in this verified user's own chooser payload;
 * there is no server-side widening here, `select-team` still enforces ACTIVE membership + domain.
 * An absent/blank hint or one that matches nothing returns null so the chooser renders normally.
 */
export function pickHintTeam(choices: WorkspaceChoices, teamHint: string | null): TeamChoice | null {
  const hint = teamHint?.trim();
  if (!hint) return null;
  return choices.teams.find((team) => team.teamId === hint || team.slug === hint) ?? null;
}

/** The subset of `usePopup()` needed to act on a `WorkspaceResponseOutcome`. */
export type WorkspaceOutcomeActions = {
  setLoginToken: (token: string | null) => void;
  setWorkspaceChoices: (choices: WorkspaceChoices | null) => void;
  setView: (view: AuthView) => void;
  redirectTo: (url: string) => void;
  startTwoFactorVerify: (token: string) => void;
  startTwoFactorSetup: (setup: TwoFactorSetupState) => void;
  /** i18n key shown once on the view we land on; null clears it. */
  setNotice: (key: TranslationKey | null) => void;
};

/**
 * Applies a decoded outcome to the popup context — the single place `CodeEntryPage`, `LoginForm`,
 * and every workspace-chooser card hand off to once they have a response. Returns false for
 * `{ kind: 'error' }` so the caller can show its own generic error copy.
 */
export function applyWorkspaceOutcome(
  outcome: WorkspaceResponseOutcome,
  actions: WorkspaceOutcomeActions,
): boolean {
  switch (outcome.kind) {
    case 'chooser':
      actions.setLoginToken(outcome.loginToken);
      actions.setWorkspaceChoices(outcome.choices);
      actions.setView('workspace-chooser');
      return true;
    case 'redirect':
      actions.redirectTo(outcome.url);
      return true;
    case 'expired':
      // Tear the dead bridge down before leaving, so the chooser cannot be re-entered with it and
      // the login view is reached with clean state. The URL still carries config_url, redirect and
      // PKCE, so signing in again resumes this same authorization request.
      actions.setWorkspaceChoices(null);
      actions.setLoginToken(null);
      // Order matters: `setView` clears any pending notice, so the reason is set after the move.
      actions.setView('login');
      actions.setNotice('notice.sessionExpired');
      return true;
    case 'twofa':
      actions.startTwoFactorVerify(outcome.token);
      return true;
    case 'twofa_enroll':
      actions.startTwoFactorSetup(outcome.setup);
      return true;
    case 'error':
      return false;
  }
}
