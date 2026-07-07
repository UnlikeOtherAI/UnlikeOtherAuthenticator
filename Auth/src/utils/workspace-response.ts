import type {
  AuthView,
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

function toInviteChoices(value: unknown): InviteChoice[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is InviteChoice =>
      isRecord(v) && typeof v.inviteId === 'string' && typeof v.teamName === 'string',
  );
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

/** The subset of `usePopup()` needed to act on a `WorkspaceResponseOutcome`. */
export type WorkspaceOutcomeActions = {
  setLoginToken: (token: string | null) => void;
  setWorkspaceChoices: (choices: WorkspaceChoices | null) => void;
  setView: (view: AuthView) => void;
  redirectTo: (url: string) => void;
  startTwoFactorVerify: (token: string) => void;
  startTwoFactorSetup: (setup: TwoFactorSetupState) => void;
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
