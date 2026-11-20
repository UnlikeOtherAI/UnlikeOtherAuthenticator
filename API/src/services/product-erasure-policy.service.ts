import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getAdminAuthDomain, getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { requireLifecycleActor, type LifecycleActor } from './internal-admin-lifecycle.service.js';
import { USER_SETTINGS_KEY_PATTERN, USER_SETTINGS_NAMESPACE_PATTERN } from './user-settings.service.js';
import { lockProductTeamPolicyExclusive } from './product-team-policy-lock.service.js';

export const ProductId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const inventory = (item: z.ZodString) => z.array(item).max(64).transform(items => [...new Set(items)].sort());
export const ProductPolicyInput = z.object({
  id: ProductId, revision: z.number().int().nonnegative(), name: z.string().trim().min(1).max(100),
  mode: z.enum(['PERSONAL', 'ORGANISATION']), enabled: z.boolean(),
  disclosure: z.string().trim().min(1).max(2000),
  domains: inventory(z.string().trim().toLowerCase().max(253)),
  nativeApps: inventory(z.string().trim().min(1).max(255)),
  settings: inventory(z.string().max(193)).refine(keys => keys.every(pair => {
    const [namespace, key, extra] = pair.split('/');
    return Boolean(namespace && key && extra === undefined && USER_SETTINGS_NAMESPACE_PATTERN.test(namespace) && USER_SETTINGS_KEY_PATTERN.test(key));
  }), 'Expected a settings namespace/key'),
}).strict();

export async function saveProductErasurePolicy(input: z.infer<typeof ProductPolicyInput>, actor: LifecycleActor) {
  return getAdminPrisma().$transaction(async tx => {
    await lockProductTeamPolicyExclusive(tx);
    const actorEmail = await requireLifecycleActor(tx as PrismaClient, actor);
    const { id, revision, ...data } = input;
    const previous = await tx.productErasurePolicy.findUnique({ where: { id } });
    if ((previous?.revision ?? 0) !== revision) throw new AppError('BAD_REQUEST', 409, 'DELETION_POLICY_CHANGED');
    if ((!data.domains.length && !data.nativeApps.length) || data.domains.includes(getAdminAuthDomain()) ||
        data.domains.includes(normalizeDomain(getEnv().MCP_OAUTH_DOMAIN ?? '')) || data.settings.some(key => key.startsWith('global/'))) {
      throw new AppError('BAD_REQUEST', 400, 'INVALID_PRODUCT_INVENTORY');
    }
    if (data.enabled && (await tx.clientDomain.count({ where: { domain: { in: data.domains }, status: 'active' } }) !== data.domains.length ||
        await tx.nativeApp.count({ where: { identifier: { in: data.nativeApps } } }) !== data.nativeApps.length)) {
      throw new AppError('BAD_REQUEST', 400, 'UNREGISTERED_PRODUCT_CLIENT');
    }
    if (await tx.productErasurePolicy.findFirst({ where: { id: { not: id }, OR: [
      { domains: { hasSome: data.domains } }, { nativeApps: { hasSome: data.nativeApps } }, { settings: { hasSome: data.settings } },
    ] } })) throw new AppError('BAD_REQUEST', 409, 'OVERLAPPING_PRODUCT_INVENTORY');
    if (previous && await tx.productErasureJob.count({ where: { policyId: id } }) &&
        (['domains','nativeApps','settings'] as const).some(k => JSON.stringify(previous[k]) !== JSON.stringify(data[k]))) {
      throw new AppError('BAD_REQUEST', 409, 'DELETION_INVENTORY_IN_USE');
    }
    const row = await tx.productErasurePolicy.upsert({ where: { id }, create: { id, ...data }, update: { ...data, revision: { increment: 1 } } });
    await tx.adminAuditLog.create({ data: { actorEmail, action: 'product.erasure_policy', metadata: { product: id, revision: row.revision } } });
    return row;
  });
}
