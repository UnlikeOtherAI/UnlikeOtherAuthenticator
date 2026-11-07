import type { BillingSmsNumberResource, PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { requireStoredStripeBilling } from './billing-team-mode.service.js';

/** The resource's unique offer catalog was captured before its payment began. */
export async function requireSmsResourceStripe(resource: BillingSmsNumberResource, db: PrismaClient) {
  if (!resource.offerId) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_OFFER_UNAVAILABLE');
  const catalogs = await db.billingRecurringAddonCatalog.findMany({ where: {
    offerId: resource.offerId, serviceId: resource.serviceId }, select: { accountId: true } });
  const accounts = [...new Set(catalogs.map((row) => row.accountId))];
  const accountId = accounts[0];
  if (accounts.length !== 1 || !accountId) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_ACCOUNT_BINDING_UNPROVEN');
  }
  return requireStoredStripeBilling(accountId, db);
}
