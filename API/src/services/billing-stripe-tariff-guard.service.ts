import { BillingAssignmentScope, BillingTariffSource, type Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';

const OPEN_CHECKOUT = { in: ['creating', 'open'] };
const LIVE_SUBSCRIPTION = { notIn: ['canceled', 'incomplete_expired'] };

async function anyPinnedRows(
  tx: Prisma.TransactionClient,
  params: {
    checkout: Prisma.BillingStripeCheckoutSessionWhereInput;
    subscription: Prisma.BillingStripeSubscriptionWhereInput;
  },
): Promise<boolean> {
  const [checkout, subscription] = await Promise.all([
    tx.billingStripeCheckoutSession.findFirst({
      where: params.checkout,
      select: { id: true },
    }),
    tx.billingStripeSubscription.findFirst({
      where: params.subscription,
      select: { id: true },
    }),
  ]);
  return Boolean(checkout || subscription);
}

function pinnedError(): never {
  throw new AppError('BAD_REQUEST', 409, 'STRIPE_TARIFF_PINNED');
}

export async function assertDefaultTariffChangeAllowed(
  tx: Prisma.TransactionClient,
  serviceId: string,
  targetTariffId: string,
): Promise<void> {
  if (
    await anyPinnedRows(tx, {
      checkout: {
        serviceId,
        tariffSource: BillingTariffSource.SERVICE_DEFAULT,
        tariffId: { not: targetTariffId },
        status: OPEN_CHECKOUT,
      },
      subscription: {
        serviceId,
        tariffSource: BillingTariffSource.SERVICE_DEFAULT,
        tariffId: { not: targetTariffId },
        status: LIVE_SUBSCRIPTION,
      },
    })
  ) {
    pinnedError();
  }
}

export async function assertTariffAssignmentChangeAllowed(
  tx: Prisma.TransactionClient,
  params: {
    serviceId: string;
    orgId: string;
    teamId: string | null;
    targetTariffId: string;
    currentAssignmentId: string | null;
  },
): Promise<void> {
  if (
    params.currentAssignmentId &&
    (await anyPinnedRows(tx, {
      checkout: {
        tariffAssignmentId: params.currentAssignmentId,
        status: OPEN_CHECKOUT,
      },
      subscription: {
        tariffAssignmentId: params.currentAssignmentId,
        status: LIVE_SUBSCRIPTION,
      },
    }))
  ) {
    pinnedError();
  }

  const scope = params.teamId ? BillingAssignmentScope.TEAM : BillingAssignmentScope.ORGANISATION;
  const scopeKey = params.teamId ? `${params.orgId}:${params.teamId}` : params.orgId;
  const overlap =
    scope === BillingAssignmentScope.TEAM
      ? {
          OR: [
            { scope: BillingAssignmentScope.ORGANISATION },
            { scope: BillingAssignmentScope.TEAM, scopeKey },
          ],
        }
      : { scope: BillingAssignmentScope.ORGANISATION };
  if (
    scope === BillingAssignmentScope.TEAM &&
    (await anyPinnedRows(tx, {
      checkout: {
        serviceId: params.serviceId,
        orgId: params.orgId,
        scope: BillingAssignmentScope.ORGANISATION,
        status: OPEN_CHECKOUT,
      },
      subscription: {
        serviceId: params.serviceId,
        orgId: params.orgId,
        scope: BillingAssignmentScope.ORGANISATION,
        status: LIVE_SUBSCRIPTION,
      },
    }))
  ) {
    pinnedError();
  }
  if (
    await anyPinnedRows(tx, {
      checkout: {
        serviceId: params.serviceId,
        orgId: params.orgId,
        tariffId: { not: params.targetTariffId },
        status: OPEN_CHECKOUT,
        ...overlap,
      },
      subscription: {
        serviceId: params.serviceId,
        orgId: params.orgId,
        tariffId: { not: params.targetTariffId },
        status: LIVE_SUBSCRIPTION,
        ...overlap,
      },
    })
  ) {
    pinnedError();
  }
}

export async function assertTariffAssignmentRemovalAllowed(
  tx: Prisma.TransactionClient,
  assignmentId: string,
): Promise<void> {
  if (
    await anyPinnedRows(tx, {
      checkout: { tariffAssignmentId: assignmentId, status: OPEN_CHECKOUT },
      subscription: {
        tariffAssignmentId: assignmentId,
        status: LIVE_SUBSCRIPTION,
      },
    })
  ) {
    pinnedError();
  }
}
