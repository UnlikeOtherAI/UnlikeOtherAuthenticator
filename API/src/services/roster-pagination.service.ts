import { createHmac, timingSafeEqual } from 'node:crypto';

import { AppError } from '../utils/errors.js';

export const ROSTER_DIRECTIONS = ['forward', 'backward'] as const;
export type RosterDirection = (typeof ROSTER_DIRECTIONS)[number];

type RosterCursorPayload = {
  binding: string;
  v: 1;
  createdAt: string;
  id: string;
};

export type RosterCursor = {
  createdAt: Date;
  id: string;
};

export type RosterPaginationMeta = {
  hasMore: boolean;
  nextCursor: string | null;
  prevCursor: string | null;
};

function cursorSignature(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

/**
 * A roster cursor is a signed keyset position, not a database id. The payload is
 * deliberately private to this module so consumers cannot couple themselves to
 * an ordering implementation that may change later.
 */
export function encodeRosterCursor(cursor: RosterCursor, secret: string, binding: string): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, binding, createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
  ).toString('base64url');
  return `${payload}.${cursorSignature(payload, secret).toString('base64url')}`;
}

export function decodeRosterCursor(value: string, secret: string, binding: string): RosterCursor {
  const [payload, signature, ...extra] = value.trim().split('.');
  if (!payload || !signature || extra.length > 0) throw new AppError('BAD_REQUEST', 400);

  const expected = cursorSignature(payload, secret);
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64url');
  } catch {
    throw new AppError('BAD_REQUEST', 400);
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new AppError('BAD_REQUEST', 400);
  }

  let decoded: RosterCursorPayload;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as RosterCursorPayload;
  } catch {
    throw new AppError('BAD_REQUEST', 400);
  }

  const createdAt = new Date(decoded.createdAt);
  if (
    decoded.v !== 1 ||
    decoded.binding !== binding ||
    !decoded.id ||
    !Number.isFinite(createdAt.getTime()) ||
    createdAt.toISOString() !== decoded.createdAt
  ) {
    throw new AppError('BAD_REQUEST', 400);
  }

  return { createdAt, id: decoded.id };
}

export function rosterKeysetWhere(cursor: RosterCursor | undefined, direction: RosterDirection) {
  if (!cursor) return {};

  const comparison = direction === 'forward' ? 'lt' : 'gt';
  return {
    OR: [
      { createdAt: { [comparison]: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { [comparison]: cursor.id } },
    ],
  };
}

export function rosterOrder(
  direction: RosterDirection,
): Array<{ createdAt: 'asc' | 'desc' } | { id: 'asc' | 'desc' }> {
  const sort = direction === 'forward' ? 'desc' : 'asc';
  return [{ createdAt: sort }, { id: sort }];
}

export function rosterPaginationMeta(params: {
  direction: RosterDirection;
  rows: Array<{ id: string; createdAt: Date }>;
  hasMore: boolean;
  hasEarlier: boolean;
  binding: string;
  secret: string;
}): RosterPaginationMeta {
  const { direction, rows, hasMore, hasEarlier, binding, secret } = params;
  const first = rows[0];
  const last = rows.at(-1);

  const forwardCursor = last ? encodeRosterCursor(last, secret, binding) : null;
  const backwardCursor = first ? encodeRosterCursor(first, secret, binding) : null;
  const nextCursor = direction === 'forward'
    ? (hasMore ? forwardCursor : null)
    : (hasEarlier ? forwardCursor : null);
  const prevCursor = direction === 'forward'
    ? (hasEarlier ? backwardCursor : null)
    : (hasMore ? backwardCursor : null);

  return {
    hasMore: nextCursor !== null,
    nextCursor,
    prevCursor,
  };
}
