import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getEnv, getPublicBaseUrl } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { requireMcpOAuthPublicProfile } from './public-profile-guard.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { PublicAuthorizationContext, resolvePublicContext } from '../../services/oauth/authorization-context.service.js';
import { buildGoogleAuthorizationUrl } from '../../services/social/google.service.js';
import { startPublicSocialFlow, clearPublicCompletion } from '../../services/oauth/social-ticket.service.js';
import { renderPublicCompletion, completePublicSocial } from '../../services/oauth/social-login.service.js';

export function registerPublicSocialRoutes(app: FastifyInstance) {
  const preHandler = [requireMcpOAuthPublicProfile, createRateLimiter({ limit: 60, windowMs: 5 * 60_000,
    keyBuilder: (r) => `native-social:${r.ip}` })];
  app.get('/oauth/social/google', { preHandler }, async (request, reply) => {
    const context = PublicAuthorizationContext.parse(request.query);
    await resolvePublicContext(context, 'google');
    const env = getEnv();
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new AppError('INTERNAL', 500);
    const state = await startPublicSocialFlow(context, reply);
    reply.header('Cache-Control', 'no-store').redirect(buildGoogleAuthorizationUrl({ clientId: env.GOOGLE_CLIENT_ID,
      redirectUri: `${getPublicBaseUrl()}/auth/callback/google`, state, selectAccount: true }), 302);
  });
  app.get('/oauth/social/complete', { preHandler }, renderPublicCompletion);
  app.post('/oauth/social/complete', { preHandler }, async (request, reply) => {
    // No cross-origin form or script may complete an ambient-cookie login.
    if (request.headers.origin !== getPublicBaseUrl() || !request.headers['content-type']?.startsWith('application/json')) throw new AppError('FORBIDDEN', 403);
    const body = z.object({ flow_id: z.string().regex(/^native_[A-Za-z0-9_-]{32}$/), code: z.string().regex(/^\d{6}$/).optional(), setup_token: z.string().max(8192).optional() }).strict().parse(request.body);
    const result = await completePublicSocial(request, body);
    if ('redirect_to' in result) clearPublicCompletion(reply, body.flow_id);
    return reply.header('Cache-Control', 'no-store').send(result);
  });
}
