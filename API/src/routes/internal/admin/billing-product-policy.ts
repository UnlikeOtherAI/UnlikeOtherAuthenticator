import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { listProductPolicies, setProductPolicy } from '../../../services/billing-product-policy.service.js';
import { bindStorageCatalog } from '../../../services/billing-storage-catalog.service.js';
import { getAdminPrisma } from '../../../db/prisma.js';
import { AppError } from '../../../utils/errors.js';
import { publishSeatOffer, withdrawSeatOffer } from '../../../services/billing-seat-offer.service.js';

const id = z.string().min(1).max(256);
const body = z.object({ organisation_id: id, source_domain: id,
  billing_timezone: id.default('UTC'), private_at_cost: z.boolean(),
  start_trial: z.boolean().default(false),
  trial_starts_at: z.string().datetime().nullable().optional(),
  trial_ends_at: z.string().datetime().nullable().optional() }).strict();
export function registerAdminProductPolicies(app: FastifyInstance): void {
  app.get('/internal/admin/billing/services/:serviceId/seat-offers', { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
    const { serviceId } = z.object({ serviceId: id }).parse(request.params);
    reply.header('Cache-Control', 'private, no-store');
    const rows = await getAdminPrisma().billingSeatOffer.findMany({ where: { serviceId }, include: { tariff: true }, orderBy: { publishedAt: 'desc' } });
    return rows.map((row) => ({ id: row.id, tariff_id: row.tariffId, currency: row.tariff.currency,
      unit_amount_minor: row.tariff.monthlyAmountMinor.toString(), usage_currency: row.tariff.usageCurrency,
      published_at: row.publishedAt.toISOString(), withdrawn_at: row.withdrawnAt?.toISOString() ?? null }));
  });
  app.post('/internal/admin/billing/services/:serviceId/seat-offers', { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
    const { serviceId } = z.object({ serviceId: id }).parse(request.params);
    const { tariff_id } = z.object({ tariff_id: id }).strict().parse(request.body);
    const claims = request.adminAccessTokenClaims;
    if (!claims) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return publishSeatOffer({ serviceId, tariffId: tariff_id, actor: { userId: claims.userId, tokenVersion: claims.tokenVersion } });
  });
  app.post('/internal/admin/billing/services/:serviceId/seat-offers/:offerId/withdraw', { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
    const { serviceId, offerId } = z.object({ serviceId: id, offerId: id }).parse(request.params);
    const claims = request.adminAccessTokenClaims;
    if (!claims) throw new AppError('UNAUTHORIZED', 401);
    await withdrawSeatOffer({ serviceId, offerId, actor: { userId: claims.userId, tokenVersion: claims.tokenVersion } });
    reply.header('Cache-Control', 'private, no-store');
    return { withdrawn: true };
  });
  const path = '/internal/admin/billing/services/:serviceId/product-policies';
  app.get(path, { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
    const { serviceId } = z.object({ serviceId: id }).parse(request.params);
    reply.header('Cache-Control', 'private, no-store');
    return listProductPolicies(serviceId);
  });
  app.post(path, { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
    const { serviceId } = z.object({ serviceId: id }).parse(request.params);
    const input = body.parse(request.body);
    const claims = request.adminAccessTokenClaims;
    if (!claims) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return setProductPolicy({ serviceId, organisationId: input.organisation_id,
      sourceDomain: input.source_domain, billingTimezone: input.billing_timezone,
      privateAtCost: input.private_at_cost,
      startTrial: input.start_trial,
      trialStartsAt: input.trial_starts_at ? new Date(input.trial_starts_at) : null,
      trialEndsAt: input.trial_ends_at ? new Date(input.trial_ends_at) : null,
      actor: { userId: claims.userId, tokenVersion: claims.tokenVersion } });
  });
  app.get('/internal/admin/billing/services/:serviceId/storage-catalogs', { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
    const { serviceId } = z.object({ serviceId: id }).parse(request.params);
    reply.header('Cache-Control', 'private, no-store');
    const rows = await getAdminPrisma().billingStorageCatalog.findMany({ where: { serviceId }, orderBy: { createdAt: 'desc' } });
    return rows.map((row) => ({ id: row.id, account_id: row.accountId, currency: row.currency,
      unit_amount_minor: row.unitAmountMinor.toString(), price_id: row.stripePriceId, version: row.version }));
  });
  app.post('/internal/admin/billing/services/:serviceId/storage-catalogs', { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
    const { serviceId } = z.object({ serviceId: id }).parse(request.params);
    const input = z.object({ currency: z.enum(['EUR', 'GBP', 'USD']), price_id: id }).strict().parse(request.body);
    const claims = request.adminAccessTokenClaims;
    if (!claims) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return bindStorageCatalog({ serviceId, currency: input.currency, priceId: input.price_id,
      actor: { userId: claims.userId, tokenVersion: claims.tokenVersion } });
  });
}
