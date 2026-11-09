import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPublicBaseUrl } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { requireMcpOAuthPublicProfile } from './public-profile-guard.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { PublicAuthorizationContext, resolvePublicContext } from '../../services/oauth/authorization-context.service.js';
import { buildSocialAuthorizationUrl } from '../../services/social/provider-authorization.service.js';
import { SocialProviderSchema } from '../../services/social/provider.base.js';
import { generateXCodeVerifier } from '../../services/social/x.service.js';
import { startPublicSocialFlow, clearPublicCompletion } from '../../services/oauth/social-ticket.service.js';
import { renderPublicCompletion, completePublicSocial } from '../../services/oauth/social-login.service.js';

export function registerPublicSocialRoutes(app: FastifyInstance) {
  const preHandler = [requireMcpOAuthPublicProfile, createRateLimiter({ limit: 60, windowMs: 5 * 60_000,
    keyBuilder: (r) => `native-social:${r.ip}` })];
  app.get('/oauth/social/:provider', { preHandler }, async (request, reply) => {
    const { provider } = z.object({ provider: SocialProviderSchema }).parse(request.params);
    const context = PublicAuthorizationContext.parse(request.query);
    await resolvePublicContext(context, provider);
    const codeVerifier = provider === 'x' ? generateXCodeVerifier() : undefined;
    const state = await startPublicSocialFlow(context, reply, provider, codeVerifier);
    reply.header('Cache-Control', 'no-store').redirect(buildSocialAuthorizationUrl({
      provider, baseUrl: getPublicBaseUrl(), state, codeVerifier, selectAccount: true,
    }), 302);
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
