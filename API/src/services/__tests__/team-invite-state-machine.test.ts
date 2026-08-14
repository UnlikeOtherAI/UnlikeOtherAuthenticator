import { describe, expect, it } from 'vitest';

import { AppError } from '../../utils/errors.js';
import {
  assertRoleGrant,
  assertTeamInviteTransition,
  canRequestRole,
  decideTeamInviteTransition,
  isActionable,
  isExpired,
  isResolved,
  isTerminal,
  type InviteStateRow,
  type TeamInviteTransition,
} from '../team-invite-state-machine.js';

const NOW = new Date('2026-08-14T12:00:00.000Z');
const FUTURE = new Date('2026-09-13T12:00:00.000Z');
const PAST = new Date('2026-08-13T12:00:00.000Z');

function invite(overrides: Partial<InviteStateRow> = {}): InviteStateRow {
  return {
    teamRole: 'member',
    approvalStatus: 'NOT_REQUIRED',
    acceptedAt: null,
    declinedAt: null,
    revokedAt: null,
    expiresAt: FUTURE,
    ...overrides,
  };
}

function decide(transition: TeamInviteTransition, row: InviteStateRow | null) {
  return decideTeamInviteTransition({ transition, invite: row, now: NOW });
}

function expectError(
  transition: TeamInviteTransition,
  row: InviteStateRow | null,
  code: string,
  statusCode: number,
): void {
  try {
    decide(transition, row);
    expect.unreachable(`expected ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    expect((err as AppError).statusCode).toBe(statusCode);
    // Generic errors only: no state detail in the message.
    expect((err as AppError).message).toBe(code);
  }
}

describe('team invite state machine — predicates', () => {
  it('treats accepted/declined/revoked timestamps as terminal', () => {
    expect(isTerminal(invite())).toBe(false);
    expect(isTerminal(invite({ acceptedAt: NOW }))).toBe(true);
    expect(isTerminal(invite({ declinedAt: NOW }))).toBe(true);
    expect(isTerminal(invite({ revokedAt: NOW }))).toBe(true);
  });

  it('treats DENIED as resolved without being terminal', () => {
    const denied = invite({ approvalStatus: 'DENIED' });
    expect(isTerminal(denied)).toBe(false);
    expect(isResolved(denied)).toBe(true);
    expect(isResolved(invite())).toBe(false);
    expect(isResolved(invite({ revokedAt: NOW }))).toBe(true);
  });

  it('actionable is the partial-unique predicate: unresolved and not DENIED', () => {
    expect(isActionable(invite())).toBe(true);
    expect(isActionable(invite({ approvalStatus: 'PENDING' }))).toBe(true);
    expect(isActionable(invite({ approvalStatus: 'APPROVED' }))).toBe(true);
    expect(isActionable(invite({ approvalStatus: 'DENIED' }))).toBe(false);
    expect(isActionable(invite({ acceptedAt: NOW }))).toBe(false);
    expect(isActionable(invite({ declinedAt: NOW }))).toBe(false);
    expect(isActionable(invite({ revokedAt: NOW }))).toBe(false);
    // Expired invites stay actionable until resolved (resend renews them).
    expect(isActionable(invite({ expiresAt: PAST }))).toBe(true);
  });

  it('expiry is a passed deadline, inclusive of the exact instant', () => {
    expect(isExpired(invite({ expiresAt: null }), NOW)).toBe(false);
    expect(isExpired(invite({ expiresAt: FUTURE }), NOW)).toBe(false);
    expect(isExpired(invite({ expiresAt: PAST }), NOW)).toBe(true);
    expect(isExpired(invite({ expiresAt: NOW }), NOW)).toBe(true);
  });
});

describe('team invite state machine — role grant rail', () => {
  it.each([
    ['owner', 'member', true],
    ['owner', 'admin', true],
    ['admin', 'member', true],
    ['admin', 'admin', true],
    ['member', 'member', true],
    ['member', 'admin', false],
    ['owner', 'owner', false],
    ['admin', 'owner', false],
    ['member', 'owner', false],
    ['superuser', 'member', false],
    ['', 'member', false],
    ['admin', 'superuser', false],
  ])('actor %s granting %s → %s', (actor, grant, expected) => {
    expect(canRequestRole(actor, grant)).toBe(expected);
  });

  it('assertRoleGrant throws generic FORBIDDEN off the rail', () => {
    expect(() => assertRoleGrant('owner', 'admin')).not.toThrow();
    try {
      assertRoleGrant('member', 'admin');
      expect.unreachable('expected FORBIDDEN');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('FORBIDDEN');
      expect((err as AppError).message).toBe('FORBIDDEN');
    }
  });
});

describe('team invite state machine — create', () => {
  it('proceeds when no invite exists', () => {
    expect(decide('create', null)).toEqual({ kind: 'proceed' });
  });

  it('is a no-op on a duplicate actionable invite', () => {
    expect(decide('create', invite())).toEqual({
      kind: 'no-op',
      reason: 'duplicate_actionable',
    });
    expect(decide('create', invite({ approvalStatus: 'PENDING' }))).toEqual({
      kind: 'no-op',
      reason: 'duplicate_actionable',
    });
    expect(decide('create', invite({ expiresAt: PAST }))).toEqual({
      kind: 'no-op',
      reason: 'duplicate_actionable',
    });
  });

  it('proceeds when the existing row is no longer actionable', () => {
    expect(decide('create', invite({ revokedAt: NOW }))).toEqual({ kind: 'proceed' });
    expect(decide('create', invite({ acceptedAt: NOW }))).toEqual({ kind: 'proceed' });
    expect(decide('create', invite({ approvalStatus: 'DENIED' }))).toEqual({ kind: 'proceed' });
  });

  it('assertTeamInviteTransition maps no-op to false', () => {
    expect(
      assertTeamInviteTransition({ transition: 'create', invite: invite(), now: NOW }),
    ).toBe(false);
    expect(assertTeamInviteTransition({ transition: 'create', invite: null, now: NOW })).toBe(
      true,
    );
  });
});

describe('team invite state machine — approve / deny', () => {
  it('approves only an unresolved unexpired PENDING invite', () => {
    expect(decide('approve', invite({ approvalStatus: 'PENDING' }))).toEqual({ kind: 'proceed' });
    expectError('approve', invite({ approvalStatus: 'NOT_REQUIRED' }), 'BAD_REQUEST', 400);
    expectError('approve', invite({ approvalStatus: 'APPROVED' }), 'BAD_REQUEST', 400);
    expectError('approve', invite({ approvalStatus: 'DENIED' }), 'BAD_REQUEST', 400);
    expectError(
      'approve',
      invite({ approvalStatus: 'PENDING', expiresAt: PAST }),
      'BAD_REQUEST',
      400,
    );
    expectError(
      'approve',
      invite({ approvalStatus: 'PENDING', revokedAt: NOW }),
      'BAD_REQUEST',
      400,
    );
  });

  it('denies only an unresolved PENDING invite, expired or not', () => {
    expect(decide('deny', invite({ approvalStatus: 'PENDING' }))).toEqual({ kind: 'proceed' });
    expect(decide('deny', invite({ approvalStatus: 'PENDING', expiresAt: PAST }))).toEqual({
      kind: 'proceed',
    });
    expectError('deny', invite({ approvalStatus: 'APPROVED' }), 'BAD_REQUEST', 400);
    expectError('deny', invite({ approvalStatus: 'DENIED' }), 'BAD_REQUEST', 400);
    expectError(
      'deny',
      invite({ approvalStatus: 'PENDING', acceptedAt: NOW }),
      'BAD_REQUEST',
      400,
    );
  });
});

describe('team invite state machine — resend', () => {
  it('resends unresolved NOT_REQUIRED or APPROVED invites, including expired ones', () => {
    expect(decide('resend', invite())).toEqual({ kind: 'proceed' });
    expect(decide('resend', invite({ approvalStatus: 'APPROVED' }))).toEqual({ kind: 'proceed' });
    expect(decide('resend', invite({ expiresAt: PAST }))).toEqual({ kind: 'proceed' });
    expect(decide('resend', invite({ approvalStatus: 'APPROVED', expiresAt: PAST }))).toEqual({
      kind: 'proceed',
    });
    expect(decide('resend', invite({ expiresAt: null }))).toEqual({ kind: 'proceed' });
  });

  it('never resends PENDING, DENIED, or terminal invites', () => {
    expectError('resend', invite({ approvalStatus: 'PENDING' }), 'BAD_REQUEST', 400);
    expectError('resend', invite({ approvalStatus: 'DENIED' }), 'BAD_REQUEST', 400);
    expectError('resend', invite({ acceptedAt: NOW }), 'BAD_REQUEST', 400);
    expectError('resend', invite({ declinedAt: NOW }), 'BAD_REQUEST', 400);
    expectError('resend', invite({ revokedAt: NOW }), 'BAD_REQUEST', 400);
  });
});

describe('team invite state machine — revoke', () => {
  it('revokes any unresolved invite and is idempotent once terminal', () => {
    expect(decide('revoke', invite())).toEqual({ kind: 'proceed' });
    expect(decide('revoke', invite({ approvalStatus: 'PENDING' }))).toEqual({ kind: 'proceed' });
    expect(decide('revoke', invite({ expiresAt: PAST }))).toEqual({ kind: 'proceed' });
    expect(decide('revoke', invite({ revokedAt: NOW }))).toEqual({
      kind: 'no-op',
      reason: 'already_terminal',
    });
    expect(decide('revoke', invite({ acceptedAt: NOW }))).toEqual({
      kind: 'no-op',
      reason: 'already_terminal',
    });
    expect(decide('revoke', invite({ declinedAt: NOW }))).toEqual({
      kind: 'no-op',
      reason: 'already_terminal',
    });
  });

  it('rejects revoking a DENIED-only invite (nothing left to revoke)', () => {
    expectError('revoke', invite({ approvalStatus: 'DENIED' }), 'BAD_REQUEST', 400);
  });

  it('assertTeamInviteTransition maps already-terminal revoke to false', () => {
    expect(
      assertTeamInviteTransition({
        transition: 'revoke',
        invite: invite({ revokedAt: NOW }),
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe('team invite state machine — accept / decline', () => {
  it('accepts only unresolved unexpired NOT_REQUIRED or APPROVED invites', () => {
    expect(decide('accept', invite())).toEqual({ kind: 'proceed' });
    expect(decide('accept', invite({ approvalStatus: 'APPROVED' }))).toEqual({ kind: 'proceed' });
    expectError('accept', invite({ approvalStatus: 'PENDING' }), 'BAD_REQUEST', 400);
    expectError('accept', invite({ approvalStatus: 'DENIED' }), 'BAD_REQUEST', 400);
    expectError('accept', invite({ expiresAt: PAST }), 'BAD_REQUEST', 400);
    expectError('accept', invite({ acceptedAt: NOW }), 'BAD_REQUEST', 400);
    expectError('accept', invite({ declinedAt: NOW }), 'BAD_REQUEST', 400);
    expectError('accept', invite({ revokedAt: NOW }), 'BAD_REQUEST', 400);
  });

  it('declines any unresolved actionable invite, expired or not', () => {
    expect(decide('decline', invite())).toEqual({ kind: 'proceed' });
    expect(decide('decline', invite({ approvalStatus: 'PENDING' }))).toEqual({ kind: 'proceed' });
    expect(decide('decline', invite({ expiresAt: PAST }))).toEqual({ kind: 'proceed' });
    expectError('decline', invite({ approvalStatus: 'DENIED' }), 'BAD_REQUEST', 400);
    expectError('decline', invite({ acceptedAt: NOW }), 'BAD_REQUEST', 400);
    expectError('decline', invite({ revokedAt: NOW }), 'BAD_REQUEST', 400);
  });
});

describe('team invite state machine — missing invite', () => {
  it.each(['approve', 'deny', 'resend', 'revoke', 'accept', 'decline'] as const)(
    '%s on a missing invite is a generic NOT_FOUND',
    (transition) => {
      expectError(transition, null, 'NOT_FOUND', 404);
    },
  );
});
