import { describe, expect, it } from 'vitest';

import {
  decodeRosterCursor,
  encodeRosterCursor,
  rosterPaginationMeta,
} from '../../src/services/roster-pagination.service.js';

const secret = 'test-shared-secret-with-enough-length';
const binding = 'organisation:org-1:status:ACTIVE';
const first = { id: 'member-new', createdAt: new Date('2026-09-01T00:00:00.000Z') };
const last = { id: 'member-old', createdAt: new Date('2026-08-01T00:00:00.000Z') };

describe('roster keyset pagination', () => {
  it('signs an opaque cursor and rejects a modified continuation', () => {
    const cursor = encodeRosterCursor(last, secret, binding);
    expect(cursor).toContain('.');
    expect(cursor).not.toBe(last.id);
    expect(decodeRosterCursor(cursor, secret, binding)).toEqual(last);
    try {
      decodeRosterCursor(`${cursor}x`, secret, binding);
      throw new Error('tampered cursor unexpectedly decoded');
    } catch (error) {
      expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    }
  });

  it('does not permit a cursor from a different roster or filter', () => {
    const cursor = encodeRosterCursor(last, secret, binding);
    expect(() =>
      decodeRosterCursor(cursor, secret, 'organisation:org-1:status:DEACTIVATED'),
    ).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
  });

  it('advertises directional next and previous metadata without exposing cursor internals', () => {
    const firstPage = rosterPaginationMeta({
      direction: 'forward',
      rows: [first, last],
      hasMore: true,
      hasEarlier: false,
      binding,
      secret,
    });
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(firstPage.prevCursor).toBeNull();

    const backwardPage = rosterPaginationMeta({
      direction: 'backward',
      rows: [first, last],
      hasMore: true,
      hasEarlier: true,
      binding,
      secret,
    });
    expect(backwardPage.nextCursor).toEqual(expect.any(String));
    expect(backwardPage.prevCursor).toEqual(expect.any(String));
  });
});
