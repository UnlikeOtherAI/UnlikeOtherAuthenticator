import { BillingAssignmentScope, type Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { BillingActorEndpoint } from './billing-actor-audience.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  authorizeBillingCustomerAction,
  BILLING_CUSTOMER_ACTION,
} from './billing-customer-action-intent.service.js';
import { resolveEffectiveTariffContext } from './billing-entitlement.service.js';
import { isOrganisationBillingManager } from './billing-org-responsibility.service.js';
import type { BillingOrgResponsibilityRequest } from './billing-org-responsibility-lifecycle.service.js';

/** The three billing regions and the currency each one bills SMS in. AI usage stays USD in all three. */
export const BILLING_REGION_CURRENCY = { UK: 'GBP', US: 'USD', EUROPE: 'EUR' } as const;
export type BillingRegion = keyof typeof BILLING_REGION_CURRENCY;
export type BillingRegionCurrency = (typeof BILLING_REGION_CURRENCY)[BillingRegion];
export const BILLING_REGIONS = Object.keys(BILLING_REGION_CURRENCY) as BillingRegion[];

// European Union, the other EEA members and Switzerland.
const EUROPE = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'CH']);

/** The region to prefill from a known billing country: GB is UK, Europe is Europe, anything else US. */
export function suggestedBillingRegion(country: string | null | undefined): BillingRegion {
  const code = country?.trim().toUpperCase();
  if (code === 'GB') return 'UK';
  if (code && EUROPE.has(code)) return 'EUROPE';
  return 'US';
}

export type BillingRegionViewV1 = {
  region: BillingRegion | null;
  currency: BillingRegionCurrency | null;
  suggested_region: BillingRegion;
  suggested_currency: BillingRegionCurrency;
  /** `billing_country` when a billing country decided the suggestion; null for the no-country US default. */
  suggested_from: 'billing_country' | null;
  can_set: boolean;
};
type RegionDb = Pick<PrismaClient | Prisma.TransactionClient,
  'billingOrganisationRegion' | 'billingOrganisationInvoiceProfile'>;

function known(region: string): BillingRegion {
  if (!(region in BILLING_REGION_CURRENCY)) throw new AppError('INTERNAL', 500, 'BILLING_REGION_INVALID');
  return region as BillingRegion;
}

/** The chosen region, or null while the organisation has not chosen one. */
export async function readOrganisationBillingRegion(organisationId: string,
  db: Pick<RegionDb, 'billingOrganisationRegion'> = getAdminPrisma()) {
  const row = await db.billingOrganisationRegion.findUnique({ where: { orgId: organisationId } });
  if (!row) return null;
  const region = known(row.region);
  return { region, currency: BILLING_REGION_CURRENCY[region] };
}

/** SMS quotes, purchases and top-ups refuse until the organisation has chosen its region. */
export async function requireOrganisationBillingRegion(organisationId: string,
  db: Pick<RegionDb, 'billingOrganisationRegion'> = getAdminPrisma()) {
  const region = await readOrganisationBillingRegion(organisationId, db);
  if (!region) throw new AppError('BAD_REQUEST', 409, 'BILLING_REGION_REQUIRED');
  return region;
}

/** What a product renders: the region (null until chosen), the prefill and whether this caller may choose. */
export async function billingRegionView(organisationId: string, canManage: boolean,
  db: RegionDb = getAdminPrisma()): Promise<BillingRegionViewV1> {
  const [chosen, profile] = await Promise.all([
    readOrganisationBillingRegion(organisationId, db),
    db.billingOrganisationInvoiceProfile.findUnique({ where: { orgId: organisationId },
      select: { billingAddress: true } }),
  ]);
  const address = profile?.billingAddress as { country?: unknown } | null | undefined;
  const country = typeof address?.country === 'string' && address.country.trim() ? address.country : null;
  const suggested = suggestedBillingRegion(country);
  return { region: chosen?.region ?? null, currency: chosen?.currency ?? null,
    suggested_region: suggested, suggested_currency: BILLING_REGION_CURRENCY[suggested],
    suggested_from: country ? 'billing_country' : null, can_set: canManage && !chosen };
}

/**
 * Choose the region once, as an organisation owner or admin. Repeating the same
 * choice changes nothing; any other choice is refused, here and in the database.
 */
export async function setOrganisationBillingRegion(params: {
  request: BillingOrgResponsibilityRequest; region: BillingRegion; actorToken: string;
  credential: VerifiedBillingAppKey; endpoint: BillingActorEndpoint;
}, deps?: { prisma?: PrismaClient; now?: () => Date; resolveTariff?: typeof resolveEffectiveTariffContext;
  isOrganisationManager?: typeof isOrganisationBillingManager; authorizeAction?: typeof authorizeBillingCustomerAction;
}): Promise<BillingRegionViewV1> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const region = known(params.region);
  // The same fresh-actor path every billing action uses, then UOA's own organisation-manager verdict.
  const { actor } = await (deps?.resolveTariff ?? resolveEffectiveTariffContext)(params, { prisma });
  const organisationId = params.request.organisationId;
  if (!await (deps?.isOrganisationManager ?? isOrganisationBillingManager)(
    { organisationId, userId: params.request.userId }, { prisma })) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_ORG_MANAGER_REQUIRED');
  }
  const settled = async () => {
    const current = await readOrganisationBillingRegion(organisationId, prisma);
    if (current && current.region !== region) throw new AppError('BAD_REQUEST', 409, 'BILLING_REGION_IMMUTABLE');
    return current;
  };
  if (!await settled()) {
    try {
      await prisma.$transaction(async (tx) => {
        await (deps?.authorizeAction ?? authorizeBillingCustomerAction)({ credential: params.credential, organisationId,
          teamId: params.request.teamId, userId: params.request.userId,
          authorityScope: BillingAssignmentScope.ORGANISATION, operation: BILLING_CUSTOMER_ACTION.BILLING_REGION_SET,
          actor, request: { product: params.request.product, organisation_id: organisationId,
            team_id: params.request.teamId, user_id: params.request.userId, region } }, { prisma: tx });
        await tx.billingOrganisationRegion.create({ data: { orgId: organisationId, region,
          currency: BILLING_REGION_CURRENCY[region], setByUserId: params.request.userId,
          setAt: deps?.now?.() ?? new Date() } });
      });
    } catch (error) {
      // A concurrent choice won the primary key; the same choice is fine, another is not.
      if ((error as { code?: unknown })?.code !== 'P2002') throw error;
    }
    await settled();
  }
  return billingRegionView(organisationId, true, prisma);
}
