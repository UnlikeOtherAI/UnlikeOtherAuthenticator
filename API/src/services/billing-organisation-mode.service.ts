import { Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { lockBillingAdminEffectAuthority, type BillingAdminEffectActor }
  from './billing-admin-effect-authority.service.js';
import type { StripeBillingMode } from './billing-stripe-client.service.js';

type ModeDb = Pick<Prisma.TransactionClient, 'organisation' | '$queryRaw'>;
export type OrganisationBillingSelection = { mode: StripeBillingMode; revision: number; epoch: string };
export type OrganisationBillingBlocker = { code: string; count: number };

export async function resolveOrganisationBillingMode(organisationId: string,
  prisma: ModeDb = getAdminPrisma()): Promise<OrganisationBillingSelection> {
  const organisation = await prisma.organisation.findFirst({ where: {
    id: organisationId, lifecycleStatus: 'ACTIVE' }, select: { id: true } });
  if (!organisation) throw new AppError('NOT_FOUND', 404, 'BILLING_ORGANISATION_NOT_AVAILABLE');
  const rows = await prisma.$queryRaw<Array<{ sandbox: boolean; revision: number; epoch: Date }>>(Prisma.sql`
    SELECT COALESCE(m.sandbox,false) AS sandbox, COALESCE(m.revision,0)::integer AS revision,
      c.activated_at AS epoch FROM billing_organisation_scope_cutover c
    LEFT JOIN billing_organisation_modes m ON m.org_id = ${organisationId} WHERE c.id = 1`);
  const row = rows[0];
  if (!row) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_ORGANISATION_CUTOVER_NOT_INSTALLED');
  return { mode: row.sandbox ? 'sandbox' : 'live', revision: row.revision, epoch: row.epoch.toISOString() };
}

export async function readOrganisationBillingMode(organisationId: string,
  prisma: PrismaClient = getAdminPrisma()) {
  const selection = await resolveOrganisationBillingMode(organisationId, prisma);
  const blockers = await prisma.$queryRaw<OrganisationBillingBlocker[]>(Prisma.sql`
    SELECT code,count::integer FROM billing_organisation_mode_blockers(${organisationId})`);
  return { organisation_id: organisationId, ...selection, blockers };
}

export async function setOrganisationBillingMode(params: {
  organisationId: string; mode: StripeBillingMode; expectedRevision: number; actor: BillingAdminEffectActor;
}, prisma: PrismaClient = getAdminPrisma()) {
  await prisma.$transaction(async (tx) => {
    await lockBillingAdminEffectAuthority(tx, params.actor);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations WHERE id = ${params.organisationId} FOR UPDATE`);
    const current = await resolveOrganisationBillingMode(params.organisationId, tx);
    if (current.revision !== params.expectedRevision) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_ORGANISATION_MODE_CHANGED');
    }
    if (current.mode === params.mode) return;
    const blockers = await tx.$queryRaw<OrganisationBillingBlocker[]>(Prisma.sql`
      SELECT code,count::integer FROM billing_organisation_mode_blockers(${params.organisationId})`);
    if (blockers.length) throw new AppError('BAD_REQUEST', 409, 'BILLING_ORGANISATION_MODE_BLOCKED');
    await tx.$executeRaw(Prisma.sql`INSERT INTO billing_organisation_modes(org_id,sandbox,revision)
      VALUES(${params.organisationId},${params.mode === 'sandbox'},1)
      ON CONFLICT(org_id) DO UPDATE SET sandbox = EXCLUDED.sandbox,
        revision = billing_organisation_modes.revision + 1, updated_at = clock_timestamp()`);
    await tx.adminAuditLog.create({ data: { actorEmail: params.actor.email,
      action: 'billing.organisation_mode_changed', metadata: { organisation_id: params.organisationId,
        previous_mode: current.mode, mode: params.mode, revision: current.revision + 1,
        scope_epoch: current.epoch, actor_user_id: params.actor.userId ?? null } } });
  });
  return readOrganisationBillingMode(params.organisationId, prisma);
}
