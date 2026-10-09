import { getAdminPrisma } from '../db/prisma.js';

function credits(microcredits: bigint | null): string | null {
  if (microcredits === null) return null;
  const fraction = (microcredits % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${microcredits / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}
/** Operator review keeps unresolved customer liability distinct from settled prepaid use. */
export async function listSmsRecoveryLiabilities(kind: 'inbound' | 'outbound', cursor?: string) {
  const db = getAdminPrisma();
  const paging = { orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), take: 101 };
  if (kind === 'inbound') {
    const rows = await db.billingSmsInboundReceipt.findMany({ ...paging,
      where: { state: { in: ['pending', 'uncollected', 'reconciliation'] } },
      select: { id: true, serviceId: true, numberId: true, allocationId: true, accountSid: true,
        messageSid: true, orgId: true, teamId: true, state: true, consumedMicrocredits: true,
        uncollectedMicrocredits: true, standingHoldId: true, createdAt: true, updatedAt: true },
    });
    return { kind, liabilities: rows.slice(0, 100).map((row) => ({ id: row.id,
      service_id: row.serviceId, number_id: row.numberId, allocation_id: row.allocationId,
      account_sid: row.accountSid, message_sid: row.messageSid, organisation_id: row.orgId,
      team_id: row.teamId, state: row.state, dispatch_id: null, standing_hold_id: row.standingHoldId,
      reserved_credits: null, consumed_credits: credits(row.consumedMicrocredits),
      uncollected_credits: credits(row.uncollectedMicrocredits),
      created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
    })), next_cursor: rows.length > 100 ? rows[99]?.id ?? null : null };
  }
  const rows = await db.billingSmsReservation.findMany({ ...paging,
    where: { state: { in: ['dispatching', 'uncertain', 'reconciliation'] } },
    select: { id: true, dispatchId: true, serviceId: true, numberId: true, allocationId: true,
      accountSid: true, messageSid: true, orgId: true, teamId: true, state: true,
      reservedMicrocredits: true, debitedMicrocredits: true, createdAt: true, updatedAt: true },
  });
  return { kind, liabilities: rows.slice(0, 100).map((row) => ({ id: row.id,
    service_id: row.serviceId, number_id: row.numberId, allocation_id: row.allocationId,
    account_sid: row.accountSid, message_sid: row.messageSid, organisation_id: row.orgId,
    team_id: row.teamId, state: row.state, dispatch_id: row.dispatchId, standing_hold_id: null,
    reserved_credits: credits(row.reservedMicrocredits), consumed_credits: credits(row.debitedMicrocredits),
    uncollected_credits: null, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
  })), next_cursor: rows.length > 100 ? rows[99]?.id ?? null : null };
}
