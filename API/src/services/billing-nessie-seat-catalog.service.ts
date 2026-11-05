import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import { usesAnniversarySeats } from './billing-nessie-onboarding.service.js';
import { ensureStripeCatalog, ensureStripeTariffPrice } from './billing-stripe-catalog.service.js';
import { CREDIT_PURCHASE_CURRENCIES } from './billing-stripe-catalog-provisioning-spec.js';
import { lockTariffHistoryService } from './billing-tariff-history.service.js';

/** Preserve the existing regional price and markup and publish new immutable collection terms. */
export async function provisionNessieSeatCatalog(params: {
  stripe: Pick<Stripe, 'accounts' | 'billing' | 'products' | 'prices'>; prisma: PrismaClient;
  expectedStripeAccountId: string; expectedLivemode: boolean; dryRun: boolean;
}) {
  const { stripe, prisma } = params;
  const remote = await stripe.accounts.retrieveCurrent();
  if (remote.id !== params.expectedStripeAccountId) throw new AppError('INTERNAL', 409, 'STRIPE_COMMERCIAL_CATALOG_ACCOUNT_MISMATCH');
  const account = await prisma.billingStripeAccount.findUniqueOrThrow({ where: { stripeAccountId_livemode: {
    stripeAccountId: remote.id, livemode: params.expectedLivemode } } });
  const service = await prisma.billingService.findFirstOrThrow({ where: { identifier: 'nessie', active: true } });
  const tariffs = await prisma.$transaction(async tx => {
    await lockTariffHistoryService(tx, service.id);
    const rows = [];
    for (const currency of CREDIT_PURCHASE_CURRENCIES) {
      const key = 'standard-' + currency.toLowerCase();
      const prior = await tx.billingTariff.findFirstOrThrow({ where: { serviceId: service.id, key }, orderBy: { version: 'desc' } });
      if (prior.currency !== currency || prior.mode !== 'STANDARD' || prior.isDefault || !usesAnniversarySeats(service.identifier, prior)) {
        throw new AppError('INTERNAL', 409, 'NESSIE_REGIONAL_SEAT_TERMS_INVALID');
      }
      if (prior.anniversarySeats || params.dryRun) { rows.push(prior); continue; }
      const created = await tx.billingTariff.create({ data: { key, serviceId: service.id, version: prior.version + 1,
        name: prior.name, mode: prior.mode, collectionMode: prior.collectionMode, markupBps: prior.markupBps,
        monthlyAmountMinor: prior.monthlyAmountMinor, monthlyChargeBasis: prior.monthlyChargeBasis,
        seatPolicy: prior.seatPolicy, seatChargeTiming: prior.seatChargeTiming,
        usagePaymentMode: prior.usagePaymentMode, currency, isDefault: false, anniversarySeats: true } });
      await tx.adminAuditLog.create({ data: { actorEmail: 'system:billing-catalog', action: 'billing.regional_seat_version_published',
        metadata: { service_id: service.id, tariff_id: created.id, previous_tariff_id: prior.id,
          stripe_account_id: remote.id, livemode: account.livemode } } });
      rows.push(created);
    }
    return rows;
  });
  const plans = [];
  for (const tariff of tariffs) {
    let priceId: string | null = null;
    if (!params.dryRun) {
      const catalog = await ensureStripeCatalog({ service, currency: tariff.currency, account, stripe }, { prisma });
      const price = await ensureStripeTariffPrice({ tariff, catalog, account, stripe }, { prisma });
      priceId = price.stripeMonthlyPriceId;
    }
    plans.push({ key: tariff.key, version: tariff.version, currency: tariff.currency,
      monthlyAmountMinor: tariff.monthlyAmountMinor.toString(), anniversarySeats: tariff.anniversarySeats, priceId });
  }
  return { dryRun: params.dryRun, stripeAccountId: remote.id, livemode: account.livemode, plans };
}
