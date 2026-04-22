import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Prisma, PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
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
// Decorate with plain-value defaults (not getters): Fastify's `decorateRequest(name, { getter })`
// installs a getter-only property on the Request prototype, which cannot be reassigned per-request
// in strict mode. We install inert defaults and then overwrite them in the onRequest hook below.
const uninitializedAdminDb = (() => {
  throw new Error('request.adminDb accessed before onRequest hook ran');
}) as unknown as PrismaClient;

const uninitializedWithTenantTx: FastifyRequest['withTenantTx'] = () => {
  throw new Error('request.withTenantTx accessed before onRequest hook ran');
};

const plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.decorateRequest('tenantContext', undefined);
  app.decorateRequest('adminDb', uninitializedAdminDb);
  app.decorateRequest('withTenantTx', uninitializedWithTenantTx);

  app.addHook('onRequest', async (request) => {
    if (getEnv().DATABASE_URL) {
      request.adminDb = getAdminPrisma();
    }
    request.withTenantTx = async (handler) => {
      const context = request.tenantContext;
      if (!context) {
        throw new Error(
          'request.withTenantTx called before request.tenantContext was set. ' +
            'Routes must populate tenantContext from request.config + access-token claims first.',
        );
      }
      // Without a database, there is nothing to open a transaction on. Services called
      // inside the handler check DATABASE_URL themselves and no-op; we invoke the handler
      // with a stand-in tx so route code stays uniform across real-DB and DB-less paths
      // (the latter only exists in specific unit tests that mock the service layer).
      if (!getEnv().DATABASE_URL) {
        return handler({} as Prisma.TransactionClient);
      }
      return runWithContext({ context, prisma: getPrisma() }, handler);
    };
  });
};

// Wrap with fastify-plugin so request decorators + onRequest hook attach to the parent scope,
// not just the plugin's own encapsulated scope. Without this, routes outside the plugin file
// see `request.withTenantTx` as undefined.
export default fp(plugin, { name: 'tenant-context' });

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
