import type { PrismaClient } from '@prisma/client';

/**
 * "Invited by …" for an invitation card: the inviter's NAME, or nothing.
 *
 * A `TeamInvite` records its inviter in one of two ways. The trusted-backend bulk endpoint is
 * given `invitedBy: { name?, email? }` and stores those strings. The member-initiated endpoint
 * (an owner/admin inviting from a product UI) has a real acting user instead and stores only
 * `invitedByUserId` — so every invitation sent that way carried a null label, and both the hosted
 * chooser's invite card and `/org/me`'s `pending_invites[]` rendered no inviter at all although
 * the inviter was perfectly well known.
 *
 * Resolution is name-on-the-row → the inviting user's own name, and null when neither exists.
 * The e-mail address is deliberately NOT a fallback, and neither is anything derived from it:
 * "Alice invited you" is the whole intent, and the address is a disclosure the invitee has not
 * otherwise been given — the invitation e-mail and its landing page name the sender by this label
 * and never by address. With no name they say "You've been invited" and name no sender at all.
 */
export type InviterLabelRow = {
  invitedByName: string | null;
  invitedByUserId: string | null;
};

export type InviterLabelPrisma = {
  user: Pick<PrismaClient['user'], 'findMany'>;
};

export type InviterLabel = (row: InviterLabelRow) => string | null;

/** A blank or whitespace-only stored name is no name at all; it must not render an empty line. */
function storedLabel(row: InviterLabelRow): string | null {
  return row.invitedByName?.trim() || null;
}

/**
 * One lookup for a whole page of invitations, never one per row — and no lookup at all when every
 * row already carries a stored label (the bulk-endpoint case, and every row on a domain that
 * never used the member-initiated endpoint).
 */
export async function resolveInviterLabel(
  rows: readonly InviterLabelRow[],
  deps: { prisma: InviterLabelPrisma },
): Promise<InviterLabel> {
  const missing = [
    ...new Set(
      rows
        .filter((row) => storedLabel(row) === null)
        .map((row) => row.invitedByUserId)
        .filter((userId): userId is string => Boolean(userId)),
    ),
  ];

  if (missing.length === 0) return storedLabel;

  // `name` only — the e-mail address is never selected here, so it cannot leak into a label by
  // a later edit either.
  const inviters = await deps.prisma.user.findMany({
    where: { id: { in: missing } },
    select: { id: true, name: true },
  });
  const labelByUserId = new Map(
    inviters.map((user) => [user.id, user.name?.trim() || null] as const),
  );

  return (row) =>
    storedLabel(row) ?? (row.invitedByUserId ? (labelByUserId.get(row.invitedByUserId) ?? null) : null);
}

/** The same resolution for a single invitation: its e-mail and landing page name one inviter. */
export async function resolveInviterName(
  row: InviterLabelRow,
  deps: { prisma: InviterLabelPrisma },
): Promise<string | null> {
  return (await resolveInviterLabel([row], deps))(row);
}
