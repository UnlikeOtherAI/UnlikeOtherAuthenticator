import { describe, expect, it } from 'vitest';

import {
  decideTeamInviteTransition,
  deriveInviteStatus,
  isActionable,
  isExpired,
  isResolved,
  isTerminal,
  type InviteLifecycleRow,
  type TeamInviteTransition,
} from '../../src/services/team-invite-state-machine.js';

const NOW = new Date('2026-03-01T00:00:00.000Z');
const PAST = new Date('2026-02-01T00:00:00.000Z');
const FUTURE = new Date('2026-04-01T00:00:00.000Z');

function row(overrides: Partial<InviteLifecycleRow> = {}): InviteLifecycleRow {
  return {
    approvalStatus: 'NOT_REQUIRED',
    acceptedAt: null,
    declinedAt: null,
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

function decide(transition: TeamInviteTransition, invite: InviteLifecycleRow | null) {
  return decideTeamInviteTransition({ transition, invite, now: NOW });
}

function throws(transition: TeamInviteTransition, invite: InviteLifecycleRow | null) {
  return () => decide(transition, invite);
}

describe('team invite state machine — predicates', () => {
  it('treats each terminal timestamp as terminal, and nothing else', () => {
    expect(isTerminal(row())).toBe(false);
    expect(isTerminal(row({ acceptedAt: PAST }))).toBe(true);
    expect(isTerminal(row({ declinedAt: PAST }))).toBe(true);
    expect(isTerminal(row({ revokedAt: PAST }))).toBe(true);
    // DENIED carries no terminal timestamp.
    expect(isTerminal(row({ approvalStatus: 'DENIED' }))).toBe(false);
  });

  it('counts DENIED as resolved but not terminal', () => {
    const denied = row({ approvalStatus: 'DENIED' });
    expect(isResolved(denied)).toBe(true);
    expect(isTerminal(denied)).toBe(false);
    expect(isActionable(denied)).toBe(false);
  });

  it('matches the partial-index predicate exactly — expiry is not part of it', () => {
    expect(isActionable(row())).toBe(true);
    expect(isActionable(row({ expiresAt: PAST }))).toBe(true);
    expect(isActionable(row({ approvalStatus: 'PENDING' }))).toBe(true);
    expect(isActionable(row({ approvalStatus: 'APPROVED' }))).toBe(true);
    expect(isActionable(row({ acceptedAt: PAST }))).toBe(false);
    expect(isActionable(row({ declinedAt: PAST }))).toBe(false);
    expect(isActionable(row({ revokedAt: PAST }))).toBe(false);
    expect(isActionable(row({ approvalStatus: 'DENIED' }))).toBe(false);
  });

  it('treats an exactly-now deadline as expired, and a missing one as never expiring', () => {
    expect(isExpired(row({ expiresAt: NOW }), NOW)).toBe(true);
    expect(isExpired(row({ expiresAt: PAST }), NOW)).toBe(true);
    expect(isExpired(row({ expiresAt: FUTURE }), NOW)).toBe(false);
    expect(isExpired(row(), NOW)).toBe(false);
  });

  it('tolerates a narrowed select where absent fields stand in for null', () => {
    // A caller may hand over a subset shape; an absent timestamp means "not in that state".
    const partial = { approvalStatus: 'NOT_REQUIRED' } as unknown as InviteLifecycleRow;
    expect(isTerminal(partial)).toBe(false);
    expect(isExpired(partial, NOW)).toBe(false);
    expect(isActionable(partial)).toBe(true);
  });
});

describe('team invite state machine — derived status', () => {
  const statusRow = (o: Partial<InviteLifecycleRow> & { revokedReason?: string | null } = {}) => ({
    ...row(o),
    revokedReason: o.revokedReason ?? null,
  });

  it('derives every wire status the products and deep.admin consume', () => {
    expect(deriveInviteStatus(statusRow(), NOW)).toBe('pending');
    expect(deriveInviteStatus(statusRow({ acceptedAt: PAST }), NOW)).toBe('accepted');
    expect(deriveInviteStatus(statusRow({ declinedAt: PAST }), NOW)).toBe('declined');
    expect(deriveInviteStatus(statusRow({ expiresAt: PAST }), NOW)).toBe('expired');
    expect(
      deriveInviteStatus(statusRow({ revokedAt: PAST, revokedReason: 'REVOKED' }), NOW),
    ).toBe('revoked');
    expect(
      deriveInviteStatus(statusRow({ revokedAt: PAST, revokedReason: 'REPLACED' }), NOW),
    ).toBe('replaced');
  });

  it('reads a pre-migration revoked row (null reason) as replaced', () => {
    expect(deriveInviteStatus(statusRow({ revokedAt: PAST, revokedReason: null }), NOW)).toBe(
      'replaced',
    );
  });

  it('never calls an already-terminal invite expired', () => {
    const expiredDeadline = { expiresAt: PAST };
    expect(deriveInviteStatus(statusRow({ ...expiredDeadline, acceptedAt: PAST }), NOW)).toBe(
      'accepted',
    );
    expect(deriveInviteStatus(statusRow({ ...expiredDeadline, declinedAt: PAST }), NOW)).toBe(
      'declined',
    );
  });

  it('ranks acceptance above every other signal', () => {
    const conflicted = statusRow({
      acceptedAt: PAST,
      declinedAt: PAST,
      revokedAt: PAST,
      revokedReason: 'REVOKED',
    });
    expect(deriveInviteStatus(conflicted, NOW)).toBe('accepted');
  });
});

describe('team invite state machine — transitions', () => {
  it('creates freshly when nothing occupies the slot', () => {
    expect(decide('create', null)).toEqual({ kind: 'proceed' });
    expect(decide('create', row({ revokedAt: PAST }))).toEqual({ kind: 'proceed' });
    expect(decide('create', row({ approvalStatus: 'DENIED' }))).toEqual({ kind: 'proceed' });
  });

  it('reports a live invite as the replaced case rather than an error', () => {
    expect(decide('create', row())).toEqual({
      kind: 'no-op',
      reason: 'duplicate_actionable',
    });
  });

  it('answers 404 for every non-create transition on a missing invite', () => {
    const transitions: TeamInviteTransition[] = [
      'approve',
      'deny',
      'resend',
      'revoke',
      'accept',
      'decline',
    ];
    for (const transition of transitions) {
      expect(throws(transition, null)).toThrowError(
        expect.objectContaining({ statusCode: 404 }),
      );
    }
  });

  it('approves only an unresolved, unexpired, still-pending invite', () => {
    expect(decide('approve', row({ approvalStatus: 'PENDING' }))).toEqual({ kind: 'proceed' });
    expect(throws('approve', row({ approvalStatus: 'NOT_REQUIRED' }))).toThrow();
    expect(throws('approve', row({ approvalStatus: 'DENIED' }))).toThrow();
    expect(throws('approve', row({ approvalStatus: 'PENDING', revokedAt: PAST }))).toThrow();
    expect(throws('approve', row({ approvalStatus: 'PENDING', declinedAt: PAST }))).toThrow();
    expect(throws('approve', row({ approvalStatus: 'PENDING', expiresAt: PAST }))).toThrow();
  });

  it('denies an expired pending invite — expiry never blocks terminal cleanup', () => {
    expect(decide('deny', row({ approvalStatus: 'PENDING', expiresAt: PAST }))).toEqual({
      kind: 'proceed',
    });
    expect(throws('deny', row({ approvalStatus: 'PENDING', revokedAt: PAST }))).toThrow();
    expect(throws('deny', row({ approvalStatus: 'NOT_REQUIRED' }))).toThrow();
  });

  it('resends an expired invite but never a resolved or unapproved one', () => {
    // Resending is how an expired invite gets a fresh token and deadline.
    expect(decide('resend', row({ expiresAt: PAST }))).toEqual({ kind: 'proceed' });
    expect(decide('resend', row({ approvalStatus: 'APPROVED' }))).toEqual({ kind: 'proceed' });
    // Regression: resend used to check only `acceptedAt`, so it could resurrect a revoked invite.
    expect(throws('resend', row({ revokedAt: PAST }))).toThrow();
    expect(throws('resend', row({ declinedAt: PAST }))).toThrow();
    expect(throws('resend', row({ acceptedAt: PAST }))).toThrow();
    expect(throws('resend', row({ approvalStatus: 'PENDING' }))).toThrow();
    expect(throws('resend', row({ approvalStatus: 'DENIED' }))).toThrow();
  });

  it('keeps the revoke endpoint contract: 409 on accepted, idempotent on terminal', () => {
    expect(decide('revoke', row({ acceptedAt: PAST }))).toEqual({
      kind: 'refuse',
      reason: 'already_accepted',
    });
    expect(decide('revoke', row({ revokedAt: PAST }))).toEqual({
      kind: 'no-op',
      reason: 'already_terminal',
    });
    expect(decide('revoke', row({ declinedAt: PAST }))).toEqual({
      kind: 'no-op',
      reason: 'already_terminal',
    });
    // Unchanged from the endpoint that introduced revoke: a DENIED or expired invite is still
    // stamped, so the two paths that were 200 before are 200 now.
    expect(decide('revoke', row({ approvalStatus: 'DENIED' }))).toEqual({ kind: 'proceed' });
    expect(decide('revoke', row({ expiresAt: PAST }))).toEqual({ kind: 'proceed' });
    expect(decide('revoke', row({ approvalStatus: 'PENDING' }))).toEqual({ kind: 'proceed' });
  });

  it('accepts only an unresolved, unexpired, approved-or-unneeded invite', () => {
    expect(decide('accept', row())).toEqual({ kind: 'proceed' });
    expect(decide('accept', row({ approvalStatus: 'APPROVED' }))).toEqual({ kind: 'proceed' });
    // Regression: a declined invite could still be accepted.
    expect(throws('accept', row({ declinedAt: PAST }))).toThrow();
    expect(throws('accept', row({ revokedAt: PAST }))).toThrow();
    expect(throws('accept', row({ expiresAt: PAST }))).toThrow();
    expect(throws('accept', row({ approvalStatus: 'PENDING' }))).toThrow();
    expect(throws('accept', row({ approvalStatus: 'DENIED' }))).toThrow();
  });

  it('declines any actionable invite, expired or not', () => {
    expect(decide('decline', row())).toEqual({ kind: 'proceed' });
    expect(decide('decline', row({ expiresAt: PAST }))).toEqual({ kind: 'proceed' });
    expect(decide('decline', row({ approvalStatus: 'PENDING' }))).toEqual({ kind: 'proceed' });
    expect(throws('decline', row({ approvalStatus: 'DENIED' }))).toThrow();
    expect(throws('decline', row({ revokedAt: PAST }))).toThrow();
  });

  it('refuses every invalid transition generically, so none is a state oracle', () => {
    const cases: Array<[TeamInviteTransition, InviteLifecycleRow]> = [
      ['approve', row({ approvalStatus: 'DENIED' })],
      ['resend', row({ revokedAt: PAST })],
      ['accept', row({ declinedAt: PAST })],
      ['decline', row({ approvalStatus: 'DENIED' })],
    ];
    for (const [transition, invite] of cases) {
      expect(throws(transition, invite)).toThrowError(
        expect.objectContaining({ statusCode: 400, message: 'BAD_REQUEST' }),
      );
    }
  });
});
