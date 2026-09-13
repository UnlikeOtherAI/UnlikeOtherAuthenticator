import type { PrismaClient } from '@prisma/client';

/**
 * "Invited by …" for an invitation card, from whichever trace of the inviter the row actually has.
 *
 * A `TeamInvite` records its inviter in one of two ways. The trusted-backend bulk endpoint is
 * given `invitedBy: { name?, email? }` and stores those strings. The member-initiated endpoint
 * (an owner/admin inviting from a product UI) has a real acting user instead and stores only
 * `invitedByUserId` — so every invitation sent that way carried a null label, and both the hosted
 * chooser's invite card and `/org/me`'s `pending_invites[]` rendered no inviter at all although
 * the inviter was perfectly well known.
 *
 * Resolution order is name-on-the-row → email-on-the-row → the inviting user's own name → their
 * e-mail address, which is the same precedence the stored pair already expresses. Exposing that
 * to the invitee reveals nothing they were not already told: the invitation e-mail names its
 * sender.
 */
export type InviterLabelRow = {
  invitedByName: string | null;
  invitedByEmail: string | null;
  invitedByUserId: string | null;
};

export type InviterLabelPrisma = {
  user: Pick<PrismaClient['user'], 'findMany'>;
};

export type InviterLabel = (row: InviterLabelRow) => string | null;

function storedLabel(row: InviterLabelRow): string | null {
  return row.invitedByName ?? row.invitedByEmail ?? null;
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

  const inviters = await deps.prisma.user.findMany({
    where: { id: { in: missing } },
    select: { id: true, name: true, email: true },
  });
  const labelByUserId = new Map(
    inviters.map((user) => [user.id, user.name ?? user.email ?? null] as const),
  );

  return (row) =>
    storedLabel(row) ?? (row.invitedByUserId ? (labelByUserId.get(row.invitedByUserId) ?? null) : null);
}
