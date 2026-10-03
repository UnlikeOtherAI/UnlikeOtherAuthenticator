import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuth } from '../../middleware/domain-hash-auth.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { issueDebugLogin, redeemDebugLogin } from '../../services/debug-login.service.js';
import { AppError } from '../../utils/errors.js';
import { tokenExchangePreAuthRateLimiter } from './rate-limit-keys.js';

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const issue = z.object({ refresh_token: z.string().min(1).max(4096), previous_token: token.optional() }).strict();
const redeem = z.object({ token }).strict();
const limit = createRateLimiter({ limit: 120, windowMs: 60_000,
  keyBuilder: (request) => `debug-login:${request.domainAuthClientDomainId}` });

export function registerDebugLoginRoutes(app: FastifyInstance): void {
  for (const action of ['issue', 'redeem'] as const) {
    app.post(`/auth/debug-login/${action}`, {
      preHandler: [tokenExchangePreAuthRateLimiter, configVerifier, requireDomainHashAuth, limit],
    }, async (request, reply) => {
      const { config, configUrl, domainAuthClientId: clientId, domainAuthClientDomainId: clientDomainId } = request;
      if (!config || !configUrl || !clientId || !clientDomainId) throw new AppError('UNAUTHORIZED', 401);
      const context = { config, configUrl, clientId, clientDomainId };
      reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
      if (action === 'issue') {
        const body = issue.parse(request.body);
        return issueDebugLogin({ ...context, refreshToken: body.refresh_token, previousToken: body.previous_token },
          { prisma: request.adminDb });
      }
      const body = redeem.parse(request.body);
      const pair = await redeemDebugLogin({ ...context, token: body.token }, { prisma: request.adminDb });
      return { access_token: pair.accessToken, expires_in: pair.expiresInSeconds,
        refresh_token: pair.refreshToken, refresh_token_expires_in: pair.refreshTokenExpiresInSeconds,
        token_type: 'Bearer' };
    });
  }
}
