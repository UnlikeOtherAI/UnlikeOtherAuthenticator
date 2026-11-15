import { Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { billingReservedMicrocredits } from './billing-credit-holds.service.js';
import { resolveCurrentBillingTariff } from './billing-current-tariff.service.js';
import { readNessieSeatAccess } from './billing-nessie-seat-access.service.js';
import { authorizeOrganisationBilling, type OrganisationBillingContext } from './billing-organisation-authority.service.js';
import { organisationFinancialAccount } from './billing-organisation-financial-account.service.js';
import { resolveOrganisationBillingMode } from './billing-organisation-mode.service.js';
import { utcBillingMonth } from './billing-tariff-history.service.js';

/** Admission signals contain no amounts or provider detail for ordinary members. Actual spending still requires a hold. */
export async function nessieBillingAccess(context: OrganisationBillingContext,
  deps: { prisma?: PrismaClient; now?: Date } = {}) {
  const prisma = deps.prisma ?? getAdminPrisma(), now = deps.now ?? new Date();
  if (context.request.product !== 'nessie') throw new AppError('FORBIDDEN', 403, 'BILLING_PRODUCT_MISMATCH');
  const viewer = await authorizeOrganisationBilling(context, prisma);
  const scope = { ...context.request, serviceId: context.credential.service.id };
  const selection = await resolveOrganisationBillingMode(scope.organisationId, prisma);
  const account = await organisationFinancialAccount(selection, prisma);
  const state = await prisma.$transaction(async tx => {
    const seats = await readNessieSeatAccess(tx, scope, now);
    const effective = await resolveCurrentBillingTariff(tx, { ...scope, billingMonth: utcBillingMonth(now) }, 'nessie');
    const subsidised = effective.source !== 'SERVICE_DEFAULT' && effective.tariff.mode === 'FREE';
    const wallet = await tx.billingCreditAccount.findUnique({ where: { accountId_scopeKey_currency: {
      accountId: account.id, scopeKey: scope.organisationId, currency: 'USD',
    } } });
    if (wallet && (wallet.orgId !== scope.organisationId || wallet.teamId !== null || wallet.scope !== 'ORGANISATION')) {
      throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_CREDIT_ACCOUNT_SCOPE_CONFLICT');
    }
    const credits = subsidised || Boolean(wallet && wallet.balanceMicrocredits > await billingReservedMicrocredits(tx, wallet.id));
    return { seats, credits };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  // Membership and financial authority may have changed while reading the financial snapshot.
  const current = await authorizeOrganisationBilling(context, prisma);
  const manager = viewer.billingManager && current.billingManager;
  return {
    schema_version: 1 as const, generated_at: now.toISOString(),
    subject: { product: 'nessie' as const, organisation_id: scope.organisationId, team_id: scope.teamId, user_id: scope.userId },
    can_manage_billing: manager,
    access: { allowed: state.seats.allowed, status: state.seats.status, deadline: state.seats.deadline },
    consumables: { available: state.seats.allowed && state.credits },
    // A team administrator has no organisation financial authority merely because they manage a team.
    ...(manager ? { manager_reason: state.seats.reason } : {}),
  };
}
