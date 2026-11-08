import type { PrismaClient } from '@prisma/client';
import type { BillingCapabilitiesV2 } from '../contracts/billing-statement-v1.js';
import { BILLING_TEAM_OVERVIEW_PATH } from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { authorizeOrganisationBilling, type OrganisationBillingContext } from './billing-organisation-authority.service.js';
import { resolveOrganisationBillingMode } from './billing-organisation-mode.service.js';

/** Current authority only. No wallet, provider, tariff or metering dependency. */
export async function billingCapabilities(context: OrganisationBillingContext,
  deps: { prisma?: PrismaClient; now?: Date } = {}): Promise<BillingCapabilitiesV2> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const viewer = await authorizeOrganisationBilling(context, prisma);
  const subject = { product: context.request.product, organisation_id: context.request.organisationId,
    team_id: context.request.teamId, user_id: context.request.userId };
  const base = { schema_version: 2 as const, generated_at: (deps.now ?? new Date()).toISOString(), subject };
  if (viewer.billingManager) return { ...base, access: 'organisation_manager', financial_scope: {
    kind: 'organisation', organisation_id: subject.organisation_id,
    ...await resolveOrganisationBillingMode(subject.organisation_id, prisma),
  } };
  if (subject.team_id !== null && ['owner', 'admin'].includes(viewer.teamRole)) {
    const selected = { ...subject, team_id: subject.team_id };
    return { ...base, subject: selected, access: 'team_reader', team_scope: { kind: 'team',
      product: subject.product, organisation_id: subject.organisation_id, team_id: subject.team_id },
    overview_request: { method: 'POST', path: BILLING_TEAM_OVERVIEW_PATH, body: selected } };
  }
  return { ...base, access: 'none' };
}
