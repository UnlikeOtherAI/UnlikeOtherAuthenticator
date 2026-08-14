import { AppError } from '../utils/errors.js';

/**
 * Pure team-invite state machine (Phase A2.1a, design §4.7). Single source of
 * truth for which invites are actionable, which are terminal, which role an
 * actor may grant, and which lifecycle transitions are allowed. The
 * A2.1a migration encodes the same invariants at the database level (partial
 * unique index + role/terminal CHECK constraints); this module encodes them
 * at the application level so the later transactional invite services share
 * one decision policy.
 *
 * Everything here is pure: no I/O, no clock reads (callers pass `now`), no
 * Prisma imports. Decisions either return a result or throw `AppError`
 * (generic codes only — no email enumeration or state detail leaks).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Approval workflow state, mirroring the `InviteApprovalStatus` enum. */
export type InviteApprovalState = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'DENIED';

/** Roles an actor can hold within a team. */
export type TeamActorRole = 'owner' | 'admin' | 'member';

/** Roles an invite may grant. `owner` is never grantable by invitation. */
export type InviteGrantRole = 'member' | 'admin';

/** Minimal invite shape every predicate and decision needs. */
export type InviteStateRow = {
  teamRole: string;
  approvalStatus: string;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
};

export type TeamInviteTransition =
  | 'create'
  | 'approve'
  | 'deny'
  | 'resend'
  | 'revoke'
  | 'accept'
  | 'decline';

export type TransitionParams = {
  transition: TeamInviteTransition;
  /** The existing invite matching (team, email), or null when none exists. */
  invite: InviteStateRow | null;
  now: Date;
};

export type TransitionDecision =
  | { kind: 'no-op'; reason: 'duplicate_actionable' | 'already_terminal' }
  | { kind: 'proceed' };

// ---------------------------------------------------------------------------
// Generic errors (no state detail in messages — security rule: all auth
// errors are generic to the user)
// ---------------------------------------------------------------------------

function badRequest(): never {
  throw new AppError('BAD_REQUEST', 400);
}

function forbidden(): never {
  throw new AppError('FORBIDDEN', 403);
}

function notFound(): never {
  throw new AppError('NOT_FOUND', 404);
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Terminal: the invite has reached a state that can never be left —
 * accepted, declined, or revoked. A DENIED approval status alone is also
 * terminal for the actionable lifecycle (the invite can never be accepted or
 * resent), but it is not a *terminal timestamp*; use `isResolved` for the
 * union of both.
 */
export function isTerminal(invite: InviteStateRow): boolean {
  return (
    invite.acceptedAt !== null || invite.declinedAt !== null || invite.revokedAt !== null
  );
}

/**
 * Resolved: no further lifecycle transition is possible. Terminal timestamp
 * or approval DENIED.
 */
export function isResolved(invite: InviteStateRow): boolean {
  return isTerminal(invite) || invite.approvalStatus === 'DENIED';
}

/**
 * Actionable: the exact predicate of the
 * `team_invites_one_actionable_per_team_email` partial unique index — not
 * accepted, not declined, not revoked, approval not DENIED. At most one such
 * row may exist per (team, lower(email)).
 */
export function isActionable(invite: InviteStateRow): boolean {
  return !isTerminal(invite) && invite.approvalStatus !== 'DENIED';
}

/** Expired: a deadline is set and has passed (or is exactly now). */
export function isExpired(invite: InviteStateRow, now: Date): boolean {
  return invite.expiresAt !== null && invite.expiresAt.getTime() <= now.getTime();
}

// ---------------------------------------------------------------------------
// Role grant rail
// ---------------------------------------------------------------------------

/**
 * Whether an actor holding `actorRole` may request an invite granting
 * `grantRole`. The rail: member actors may grant member only; owner/admin
 * actors may grant member or admin; no actor can invite owner. Unknown
 * values fail closed.
 */
export function canRequestRole(actorRole: string, grantRole: string): boolean {
  if (grantRole !== 'member' && grantRole !== 'admin') return false;
  if (actorRole === 'owner' || actorRole === 'admin') return true;
  if (actorRole === 'member') return grantRole === 'member';
  return false;
}

/** Assert the role rail or throw a generic FORBIDDEN. */
export function assertRoleGrant(actorRole: string, grantRole: string): void {
  if (!canRequestRole(actorRole, grantRole)) forbidden();
}

// ---------------------------------------------------------------------------
// Per-transition rules
// ---------------------------------------------------------------------------

/**
 * create: a duplicate actionable invite for the same (team, email) is a
 * no-op, not an error — the caller learns nothing new about whether the
 * email already has an invite. Any other existing row is superseded by the
 * new row (its state no longer matches the actionable predicate).
 */
function decideCreate(invite: InviteStateRow | null): TransitionDecision {
  if (invite !== null && isActionable(invite)) {
    return { kind: 'no-op', reason: 'duplicate_actionable' };
  }
  return { kind: 'proceed' };
}

/** approve: only an unresolved, unexpired invite awaiting approval. */
function decideApprove(invite: InviteStateRow, now: Date): TransitionDecision {
  if (isResolved(invite) || invite.approvalStatus !== 'PENDING' || isExpired(invite, now)) {
    badRequest();
  }
  return { kind: 'proceed' };
}

/** deny: only an unresolved invite awaiting approval (expiry irrelevant). */
function decideDeny(invite: InviteStateRow): TransitionDecision {
  if (isResolved(invite) || invite.approvalStatus !== 'PENDING') badRequest();
  return { kind: 'proceed' };
}

/**
 * resend: any unresolved invite that does not need approval — NOT_REQUIRED
 * or APPROVED. Expiry does not block a resend: resending is how an expired
 * actionable invite gets a fresh token and deadline. PENDING invites cannot
 * be resent (nothing approved to mail yet).
 */
function decideResend(invite: InviteStateRow): TransitionDecision {
  if (isResolved(invite)) badRequest();
  if (invite.approvalStatus !== 'NOT_REQUIRED' && invite.approvalStatus !== 'APPROVED') {
    badRequest();
  }
  return { kind: 'proceed' };
}

/**
 * revoke: unresolved invites only; revoking an already-terminal invite is an
 * idempotent no-op. A DENIED-only invite (resolved but not terminal) is not
 * revocable — there is nothing left to revoke.
 */
function decideRevoke(invite: InviteStateRow): TransitionDecision {
  if (isTerminal(invite)) return { kind: 'no-op', reason: 'already_terminal' };
  if (isResolved(invite)) badRequest();
  return { kind: 'proceed' };
}

/** accept: only an unresolved, unexpired invite that needs no approval. */
function decideAccept(invite: InviteStateRow, now: Date): TransitionDecision {
  if (isResolved(invite) || isExpired(invite, now)) badRequest();
  if (invite.approvalStatus !== 'NOT_REQUIRED' && invite.approvalStatus !== 'APPROVED') {
    badRequest();
  }
  return { kind: 'proceed' };
}

/** decline: any unresolved actionable invite, expired or not. */
function decideDecline(invite: InviteStateRow): TransitionDecision {
  if (isResolved(invite) || !isActionable(invite)) badRequest();
  return { kind: 'proceed' };
}

/**
 * Decide whether a lifecycle transition may proceed. `create` tolerates a
 * missing invite; every other transition throws a generic NOT_FOUND when the
 * invite does not exist.
 */
export function decideTeamInviteTransition(params: TransitionParams): TransitionDecision {
  const { transition, invite, now } = params;
  if (transition === 'create') return decideCreate(invite);
  if (invite === null) notFound();
  switch (transition) {
    case 'approve':
      return decideApprove(invite, now);
    case 'deny':
      return decideDeny(invite);
    case 'resend':
      return decideResend(invite);
    case 'revoke':
      return decideRevoke(invite);
    case 'accept':
      return decideAccept(invite, now);
    case 'decline':
      return decideDecline(invite);
    default:
      badRequest();
  }
}

/**
 * Assert a transition may proceed, translating allowed no-ops into a
 * boolean: returns `true` when the caller should perform the mutation,
 * `false` when the transition is a legal no-op (duplicate create,
 * re-revoke). Convenience wrapper for services that do not need the reason.
 */
export function assertTeamInviteTransition(params: TransitionParams): boolean {
  return decideTeamInviteTransition(params).kind === 'proceed';
}
