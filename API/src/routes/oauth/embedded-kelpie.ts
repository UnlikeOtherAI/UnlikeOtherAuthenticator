import { asPrismaClient } from '../../db/tenant-context.js';
import { decodeJwt } from 'jose';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { resolveOrgUserClaims } from '../../middleware/org-role-guard.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { verifyDomainAuthToken } from '../../services/domain-secret.service.js';
import { issueEmbeddedKelpieSession, verifyEmbeddedKelpieToken, authorizeEmbeddedKelpieAccount,
  issueEmbeddedKelpieConnection, validateEmbeddedKelpieConnection } from '../../services/oauth/embedded-kelpie.service.js';
import { validateKelpieConnectionTicket } from '../../services/oauth/kelpie-connect.service.js';
import { kelpieConnectResource } from '../../services/oauth/kelpie-connect-policy.js';
import { isMcpOAuthPublicProfileEnabled } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { registerBrowserAccountRoutes } from '../oauth/browser-account.js';

export function registerEmbeddedKelpieRoutes(parent: FastifyInstance): void {
  void parent.register(async app => {
    app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); });
  app.post('/org/me/kelpie/session', {
    preHandler: [requireDomainHashAuthForDomainQuery(), configVerifier,
      createRateLimiter({ limit: 120, windowMs: 60_000, keyBuilder: request => `embedded-kelpie:issue:${request.domainAuthClientDomainId}` })],
  }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const query = z.object({ domain: z.string(), config_url: z.string() }).strict().parse(request.query);
    z.object({}).strict().parse(request.body);
    const domain = request.config?.domain;
    const clientDomainId = request.domainAuthClientDomainId;
    if (!domain || query.domain !== domain || !clientDomainId || domain !== new URL(kelpieConnectResource()).host) {
      throw new AppError('FORBIDDEN', 403);
    }
    const claims = await resolveOrgUserClaims(request);
    if (claims.domain !== domain || !claims.assuranceId) throw new AppError('UNAUTHORIZED', 401);
    return issueEmbeddedKelpieSession({ userId: claims.userId, domain, clientDomainId,
      credentialEpoch: claims.tokenVersion, assuranceId: claims.assuranceId,
      orgId: claims.active?.orgId ?? null, teamId: claims.active?.teamId ?? null }, request.adminDb);
  });

  const preHandler = [async () => { kelpieConnectResource(); },
    createRateLimiter({ limit: 120, windowMs: 60_000, keyBuilder: request => `embedded-kelpie:account:${request.ip}` })];
  registerBrowserAccountRoutes(app, { prefix: '/embedded/kelpie', preHandler, settingsScope: 'bookmarks',
    verify: verifyEmbeddedKelpieToken, authorize: authorizeEmbeddedKelpieAccount });
  app.post('/embedded/kelpie/connect', { preHandler }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { resource } = z.object({ resource: z.string().min(1).max(2048) }).strict().parse(request.body);
    return issueEmbeddedKelpieConnection(request.headers.authorization, resource, request.adminDb);
  });

  // The gateway uses one strict validator for both explicit credential sources.
  app.post('/embedded/kelpie/connect/validate', {
    preHandler: [requireDomainHashAuthForDomainQuery(), async () => { kelpieConnectResource(); },
      createRateLimiter({ limit: 12000, windowMs: 60_000, keyBuilder: () => 'embedded-kelpie:validate' })],
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { domain } = z.object({ domain: z.string() }).strict().parse(request.query);
    const { ticket } = z.object({ ticket: z.string().min(1).max(8192) }).strict().parse(request.body);
    const domainCredential = request.domainAuthClientId;
    if (!domainCredential || domain !== new URL(kelpieConnectResource()).host) throw new AppError('UNAUTHORIZED', 401);
    let tokenUse: unknown;
    try { tokenUse = decodeJwt(ticket).token_use; } catch { throw new AppError('UNAUTHORIZED', 401); }
    // Decoding selects a verifier only. Each verifier checks its own signed class and audience.
    if (tokenUse === 'embedded_kelpie_connect') {
      return validateEmbeddedKelpieConnection(ticket, request.adminDb, async tx => {
        await verifyDomainAuthToken({ domain, token: domainCredential }, { prisma: asPrismaClient(tx) });
      });
    }
    if (tokenUse !== 'kelpie_connect' || !isMcpOAuthPublicProfileEnabled()) throw new AppError('UNAUTHORIZED', 401);
    return { ...await validateKelpieConnectionTicket({ ticket, domain, domainCredential }, request.adminDb), source: 'native' };
  });
  });
}
