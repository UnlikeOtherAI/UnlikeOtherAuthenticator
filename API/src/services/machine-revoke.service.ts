import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import { lockRefreshSessionUser } from './refresh-session-lock.service.js';
import { machineTransaction, type MachineDb } from './machine-authority.service.js';
import { machineRefused } from './machine-crypto.js';
import type { machineBrowser } from './machine-browser.service.js';
import { requireLifecycleActor, type LifecycleActor } from './internal-admin-lifecycle.service.js';
import { isActiveUser } from './entity-lifecycle.service.js';
import { writeAuditLog } from './audit-log.service.js';

export async function revokeOwnedMachines(session: Awaited<ReturnType<typeof machineBrowser>>,
  id: string | 'all', tx: MachineDb) {
  const where = { subject: session.subject, clientDomain: session.clientDomain, orgId: session.orgId,
    teamId: session.teamId, ...(id === 'all' ? {} : { id }) };
  const rows = await tx.machineEnrollment.findMany({ where, orderBy: { id: 'asc' } });
  if (id !== 'all' && rows.length !== 1) machineRefused();
  for (const row of rows) {
    await tx.$queryRaw`SELECT id FROM machine_enrollments WHERE id=${row.id}::uuid FOR UPDATE`;
    const current = await tx.machineEnrollment.findUniqueOrThrow({ where: { id: row.id } });
    await revokeMachineRow(current, id === 'all' ? 'all_devices_revoked' : 'device_revoked', tx);
  }
  return { ok: true, version: 1 };
}
async function revokeMachineRow(row: Awaited<ReturnType<MachineDb['machineEnrollment']['findUniqueOrThrow']>>,
  reason: 'device_revoked' | 'all_devices_revoked', tx: MachineDb) {
  if (row.status === 'revoked' && ['device_revoked', 'all_devices_revoked', 'credential_replay', 'lineage_invalid'].includes(row.reason)) return;
  // Explicit owner retirement also makes a previously held/reset grant terminal.
  await tx.machineEnrollment.update({ where: { id: row.id }, data: { status: 'revoked', reason,
    sourceVersion: { increment: 1 } } });
}
export async function adminMachineInventory(subject: string, db: MachineDb) {
  const rows = await db.machineEnrollment.findMany({ where: { subject }, orderBy: { createdAt: 'desc' }, take: 101 });
  const [organizations, teams] = await Promise.all([
    db.organisation.findMany({ where: { id: { in: rows.map(row => row.orgId) } }, select: { id: true, name: true } }),
    db.team.findMany({ where: { id: { in: rows.map(row => row.teamId) } }, select: { id: true, orgId: true, name: true } }),
  ]);
  return { version: 1, data: rows.slice(0, 100).map(row => ({ enrollment_id: row.id, device_name: row.deviceName,
    client_domain: row.clientDomain, organization_id: row.orgId, team_id: row.teamId,
    organization_name: organizations.find(org => org.id === row.orgId)?.name ?? null,
    team_name: teams.find(team => team.id === row.teamId && team.orgId === row.orgId)?.name ?? null,
    decision: row.status, reason: row.reason, created_at: row.createdAt.toISOString() })), truncated: rows.length > 100 };
}
export async function adminRevokeMachine(input: { subject: string; enrollmentId?: string; actor: LifecycleActor }) {
  return machineTransaction(async tx => {
    await lockProductTeamPolicyShared(tx);
    for (const id of [...new Set([input.subject, input.actor.userId])].sort()) await lockRefreshSessionUser(id, { prisma: tx });
    const actorEmail = await requireLifecycleActor(tx, input.actor);
    const actorUser = await tx.user.findUnique({ where: { id: input.actor.userId }, select: { lifecycleStatus: true, accountExpiresAt: true } });
    if (!isActiveUser(actorUser)) machineRefused();
    const rows = await tx.machineEnrollment.findMany({ where: { subject: input.subject,
      ...(input.enrollmentId ? { id: input.enrollmentId } : {}) }, orderBy: { id: 'asc' } });
    if (input.enrollmentId && rows.length !== 1) machineRefused();
    for (const row of rows) {
      await tx.$queryRaw`SELECT id FROM machine_enrollments WHERE id=${row.id}::uuid FOR UPDATE`;
      const current = await tx.machineEnrollment.findUniqueOrThrow({ where: { id: row.id } });
      await revokeMachineRow(current, input.enrollmentId ? 'device_revoked' : 'all_devices_revoked', tx);
    }
    await writeAuditLog({ actorEmail, action: 'machine.revoked', metadata: { subject: input.subject, all: !input.enrollmentId } }, { prisma: tx });
    return { ok: true, version: 1 };
  });
}
