import { AppError } from '../../../utils/errors.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { configVerifier } from '../../../middleware/config-verifier.js';
import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { tokenExchangePreAuthRateLimiter } from '../../auth/rate-limit-keys.js';
import { issueDebugLogin, redeemDebugLogin } from '../../../services/debug-login.service.js';
import { revokeRefreshTokenFamily } from '../../../services/refresh-token.service.js';
import { adminDebugContext, assertAdminDebugRequest, assertAdminDebugAuthority,
  readAdminSource, storeAdminSessionHandle, clearAdminSessionHandle, adminSessionCookieName, adminBearer, assertAdminDebugOrigin } from '../../../services/admin-debug-session.service.js';

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export function registerInternalAdminDebugLoginRoutes(app: FastifyInstance): void {
  app.post('/internal/admin/debug-login/issue', {
    preHandler: [tokenExchangePreAuthRateLimiter, async (request) => { assertAdminDebugOrigin(request); }, configVerifier, requireAdminSuperuser],
  }, async (request, reply) => {
    assertAdminDebugRequest(request);
    if (!request.config) throw new AppError('UNAUTHORIZED', 401);
    const body = z.object({ previous_token: token.optional() }).strict().parse(request.body);
    const context = { ...adminDebugContext(), config: request.config };
    let sourceExpiresAt = 0;
    const result = await issueDebugLogin({ ...context, refreshToken: readAdminSource(request), previousToken: body.previous_token }, {
      prisma: request.adminDb, assertAuthority: async (source, prisma) => {
        await assertAdminDebugAuthority(source, prisma, request.adminAccessTokenClaims?.userId);
        sourceExpiresAt = source.expiresAt.getTime();
      },
    });
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
    return { url: new URL('/admin/login', context.configUrl).toString(), token: result.token,
      expires_in: Math.min(result.expires_in, Math.max(0, Math.floor((sourceExpiresAt - Date.now()) / 1000))) };
  });
  app.post('/internal/admin/debug-login/redeem', {
    preHandler: [tokenExchangePreAuthRateLimiter, async (request) => { assertAdminDebugOrigin(request); }, configVerifier],
  }, async (request, reply) => {
    assertAdminDebugRequest(request);
    if (!request.config) throw new AppError('UNAUTHORIZED', 401);
    const body = z.object({ token }).strict().parse(request.body);
    const pair = await redeemDebugLogin({ ...adminDebugContext(), config: request.config, token: body.token }, {
      prisma: request.adminDb, assertAuthority: assertAdminDebugAuthority,
    });
    await storeAdminSessionHandle(pair, request.adminDb, reply);
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
    return { access_token: pair.accessToken, expires_in: pair.expiresInSeconds, token_type: 'Bearer' };
  });
  app.post('/internal/admin/logout', {
    preHandler: [tokenExchangePreAuthRateLimiter, async (request) => { assertAdminDebugOrigin(request); }, configVerifier, requireAdminSuperuser],
  }, async (request, reply) => {
    assertAdminDebugRequest(request);
    if (!request.config) throw new AppError('UNAUTHORIZED', 401);
    z.object({}).strict().parse(request.body);
    const refreshToken = request.cookies[adminSessionCookieName(adminBearer(request))];
    if (refreshToken) await revokeRefreshTokenFamily({ ...adminDebugContext(), refreshToken, familyOnly: true }, { prisma: request.adminDb });
    clearAdminSessionHandle(request, reply);
    reply.header('Cache-Control', 'no-store');
    return { ok: true };
  });
}
