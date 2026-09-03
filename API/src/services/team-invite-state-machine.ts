import { AppError } from '../utils/errors.js';

/**
 * Pure team-invite state machine (design §4.7). Single source of truth for which invites are
 * actionable, which are terminal, which status a row reads as, and which lifecycle transitions
 * are allowed. The `20260816140000_team_invite_actionable_invariants` migration encodes the same
 * invariants at the database level (partial unique index + terminal-coherence CHECK constraints);
 * this module encodes them at the application level so every invite service shares one decision
 * policy instead of re-deriving it per call site.
 *
 * Everything here is pure: no I/O, no clock reads (callers pass `now`), no Prisma imports.
 *
 * Deliberately NOT here: who may invite, and which role they may grant. That is a capability
 * question, owned by `role-grants.ts` + `hasTeamCapability`, and a vocabulary question, owned
 * by the domain's configured `team_roles`. A state machine that also carried an
 * `owner|admin|member` actor rail would be a second, hard-coded authorization model beside the
 * configurable one — exactly the predicate the capability table replaced.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The read-only status a caller sees. Wire contract — consumed by products and deep.admin. */
export type TeamInviteStatusValue =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'replaced'
  | 'revoked'
  | 'expired';

/**
 * The minimal lifecycle shape every predicate and transition decision needs. Deliberately
 * structural rather than a Prisma type so callers can pass any `select`ed subset.
 */
export type InviteLifecycleRow = {
  approvalStatus: string;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
};

/** `InviteLifecycleRow` plus the field that separates an explicit revoke from a replacement. */
export type InviteStatusRow = InviteLifecycleRow & {
  revokedReason: string | null;
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
  /** The existing invite this transition acts on, or null when none exists. */
  invite: InviteLifecycleRow | null;
  now: Date;
};

/**
 * `proceed` — perform the mutation.
 * `no-op` — a legal, idempotent non-action; the caller reports success without writing.
 * `refuse` — a caller-specific refusal the caller maps to its own documented status code
 *   (revoke maps `already_accepted` to 409 `INVITATION_ALREADY_ACCEPTED`).
 *
 * Everything else throws a generic `AppError` from inside the decision, so no call site can
 * accidentally turn an invalid transition into a state oracle.
 */
export type TransitionDecision =
  | { kind: 'proceed' }
  | { kind: 'no-op'; reason: 'duplicate_actionable' | 'already_terminal' }
  | { kind: 'refuse'; reason: 'already_accepted' };

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Terminal: accepted, declined, or revoked — a state that can never be left.
 *
 * Every timestamp test here and below is a truthiness check, not `!== null`. Prisma returns `null`
 * for an unset column, but a caller may hand over a narrower `select`ed shape where the field is
 * simply absent, and an absent timestamp means "not in that state" exactly as a null one does.
 */
export function isTerminal(invite: InviteLifecycleRow): boolean {
  return Boolean(invite.acceptedAt || invite.declinedAt || invite.revokedAt);
}

/**
 * Resolved: no further lifecycle transition is possible — terminal, or approval DENIED. A DENIED
 * invite carries no terminal timestamp but can never be accepted or resent.
 */
export function isResolved(invite: InviteLifecycleRow): boolean {
  return isTerminal(invite) || invite.approvalStatus === 'DENIED';
}

/**
 * Actionable: exactly the predicate of the `team_invites_one_actionable_per_team_email` partial
 * unique index — not accepted, not declined, not revoked, approval not DENIED. At most one such
 * row exists per `(team, lower(email))`, which is what makes "the" actionable invite well-defined.
 *
 * Deliberately says nothing about expiry: an expired invite is still the one occupying the slot,
 * and resending it is how it gets a fresh deadline.
 */
export function isActionable(invite: InviteLifecycleRow): boolean {
  return !isTerminal(invite) && invite.approvalStatus !== 'DENIED';
}

/** Expired: a deadline is set and has passed (or is exactly now). */
export function isExpired(invite: InviteLifecycleRow, now: Date): boolean {
  return invite.expiresAt ? invite.expiresAt.getTime() <= now.getTime() : false;
}

/**
 * The derived read-only status. This is the ONE implementation — `toInviteRecord` calls it, so
 * the status a product reads and the status this module reasons about cannot drift apart.
 *
 * A null `revokedReason` is a pre-`20260815090000` row, and every one of those was revoked by
 * being replaced with a newer invite for the same email.
 */
export function deriveInviteStatus(row: InviteStatusRow, now: Date): TeamInviteStatusValue {
  if (row.acceptedAt) return 'accepted';
  if (row.declinedAt) return 'declined';
  if (row.revokedAt) return row.revokedReason === 'REVOKED' ? 'revoked' : 'replaced';
  return isExpired(row, now) ? 'expired' : 'pending';
}

// ---------------------------------------------------------------------------
// Per-transition rules
// ---------------------------------------------------------------------------

function badRequest(): never {
  throw new AppError('BAD_REQUEST', 400);
}

/**
 * create: an existing actionable invite is not an error — it is replaced. The caller revokes it
 * as REPLACED and creates the new row, which is why this returns `no-op` rather than throwing:
 * `no-op` here means "no *fresh* invite", i.e. the caller reports `resent_existing`.
 */
function decideCreate(invite: InviteLifecycleRow | null): TransitionDecision {
  if (invite !== null && isActionable(invite)) {
    return { kind: 'no-op', reason: 'duplicate_actionable' };
  }
  return { kind: 'proceed' };
}

/** approve: only an unresolved, unexpired invite still awaiting approval. */
function decideApprove(invite: InviteLifecycleRow, now: Date): TransitionDecision {
  if (isResolved(invite) || invite.approvalStatus !== 'PENDING' || isExpired(invite, now)) {
    badRequest();
  }
  return { kind: 'proceed' };
}

/** deny: only an unresolved invite awaiting approval. Expiry never blocks terminal cleanup. */
function decideDeny(invite: InviteLifecycleRow): TransitionDecision {
  if (isResolved(invite) || invite.approvalStatus !== 'PENDING') badRequest();
  return { kind: 'proceed' };
}

/**
 * resend: any unresolved invite that needs no further approval. Expiry does not block it —
 * resending is how an expired invite gets a fresh token and deadline. A PENDING invite cannot be
 * resent because nothing has been approved to mail yet.
 */
function decideResend(invite: InviteLifecycleRow): TransitionDecision {
  if (isResolved(invite)) badRequest();
  if (invite.approvalStatus !== 'NOT_REQUIRED' && invite.approvalStatus !== 'APPROVED') {
    badRequest();
  }
  return { kind: 'proceed' };
}

/**
 * revoke: the caller-visible contract of `DELETE .../invitations/:inviteId`, unchanged from the
 * endpoint that introduced it.
 *
 *   - accepted → `refuse`, which the caller reports as 409 `INVITATION_ALREADY_ACCEPTED`
 *     (membership already exists; removing the member is a member-lifecycle action).
 *   - already revoked or declined → idempotent `no-op`: no second write, no second audit row.
 *   - anything else, DENIED and expired included → `proceed`. A DENIED invite is resolved but
 *     still carries no terminal timestamp, and stamping one is what the endpoint has always done.
 */
function decideRevoke(invite: InviteLifecycleRow): TransitionDecision {
  if (invite.acceptedAt) return { kind: 'refuse', reason: 'already_accepted' };
  if (invite.revokedAt || invite.declinedAt) {
    return { kind: 'no-op', reason: 'already_terminal' };
  }
  return { kind: 'proceed' };
}

/** accept: only an unresolved, unexpired invite that needs no approval. */
function decideAccept(invite: InviteLifecycleRow, now: Date): TransitionDecision {
  if (isResolved(invite) || isExpired(invite, now)) badRequest();
  if (invite.approvalStatus !== 'NOT_REQUIRED' && invite.approvalStatus !== 'APPROVED') {
    badRequest();
  }
  return { kind: 'proceed' };
}

/** decline: any actionable invite, expired or not. */
function decideDecline(invite: InviteLifecycleRow): TransitionDecision {
  if (!isActionable(invite)) badRequest();
  return { kind: 'proceed' };
}

/**
 * Decide whether a lifecycle transition may proceed. `create` tolerates a missing invite; every
 * other transition throws a generic 404 when there is no invite to act on.
 */
export function decideTeamInviteTransition(params: TransitionParams): TransitionDecision {
  const { transition, invite, now } = params;
  if (transition === 'create') return decideCreate(invite);
  if (invite === null) throw new AppError('NOT_FOUND', 404);
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
      return badRequest();
  }
}

/**
 * Assert a transition may proceed, for the call sites that have no legal no-op to distinguish.
 * Throws on anything the decision refuses or rejects.
 */
export function assertTeamInviteTransition(params: TransitionParams): void {
  const decision = decideTeamInviteTransition(params);
  if (decision.kind !== 'proceed') badRequest();
}
