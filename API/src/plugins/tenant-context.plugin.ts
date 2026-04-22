import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';

import { getAdminPrisma, getPrisma } from '../db/prisma.js';
import {
  runWithTenantContext as runWithContext,
  type TenantContext,
} from '../db/tenant-context.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantContext?: TenantContext;
    adminDb: PrismaClient;
    withTenantTx: <T>(handler: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  }
}

// Register `request.adminDb` (BYPASSRLS client) and `request.withTenantTx` (opens an interactive
// transaction on the tenant-scoped Prisma client and sets app.domain/app.org_id/app.user_id GUCs).
//
// `request.tenantContext` is populated on-demand by callers — the plugin does not auto-extract
// it from `request.config` because different routes resolve `orgId`/`userId` from different
// sources (access-token claims, URL params, body). Routes that wrap their handler in
// `request.withTenantTx` must set `request.tenantContext` first (or pass context explicitly
// via `runWithTenantContext`).
const plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.decorateRequest('tenantContext', undefined);
  app.decorateRequest('adminDb', {
    getter() {
      throw new Error('request.adminDb accessed before onRequest hook ran');
    },
  });
  app.decorateRequest('withTenantTx', {
    getter() {
      throw new Error('request.withTenantTx accessed before onRequest hook ran');
    },
  });

  app.addHook('onRequest', async (request) => {
    request.adminDb = getAdminPrisma();
    request.withTenantTx = async (handler) => {
      const context = request.tenantContext;
      if (!context) {
        throw new Error(
          'request.withTenantTx called before request.tenantContext was set. ' +
            'Routes must populate tenantContext from request.config + access-token claims first.',
        );
      }
      return runWithContext({ context, prisma: getPrisma() }, handler);
    };
  });
};

export default plugin;

/**
 * Populate `request.tenantContext` from the verified config JWT domain and any
 * resolved access-token claims. Call this from a route after `configVerifier`
 * (and optionally `requireOrgRole`) has run, before invoking `request.withTenantTx`.
 */
export function setTenantContextFromRequest(
  request: FastifyRequest,
  extras?: { orgId?: string | null; userId?: string | null },
): void {
  const domain = request.config?.domain;
  if (!domain) {
    throw new Error('setTenantContextFromRequest: request.config.domain is not set');
  }
  const claims = request.accessTokenClaims;
  request.tenantContext = {
    domain,
    orgId: extras?.orgId ?? claims?.org?.org_id ?? null,
    userId: extras?.userId ?? claims?.userId ?? null,
  };
}
