import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireSameOriginBrowserRequest } from '../../middleware/same-origin-browser.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { AppError } from '../../utils/errors.js';
import { hashAssuranceReference } from '../../services/session-assurance.service.js';
import { startEnterpriseAccountLink, startLinkPersonalFactor, verifyLinkPersonalFactor } from '../../services/org-sso-link-factor.service.js';

const Intent = z.string().min(1).max(100);
export function registerEnterpriseAccountLinkRoutes(app: FastifyInstance): void {
  const rate = createRateLimiter({ keyBuilder: (request) => `enterprise-link:${request.ip}`, limit: 20, windowMs: 60000 });
  const hintRate = createRateLimiter({ keyBuilder: (request) => {
    const value = z.object({ email: z.string().max(320) }).passthrough().safeParse(request.body);
    return `enterprise-link-hint:${hashAssuranceReference(value.success ? value.data.email.trim().toLowerCase() : 'invalid')}`;
  }, limit: 6, windowMs: 60000 });
  const preHandler = [requireSameOriginBrowserRequest, rate, configVerifier];
  app.post('/auth/enterprise-link/start', { preHandler }, async (request, reply) => {
    const body = z.object({ link_intent_id: Intent, login_token: z.string().min(1).max(4096) }).strict().parse(request.body);
    if (!request.config || !request.configUrl) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
    const result = await startEnterpriseAccountLink({
      linkIntentId: body.link_intent_id, loginToken: body.login_token, browser: request.cookies.uoa_sso_link,
      config: request.config, configUrl: request.configUrl, ip: request.ip });
    if ('redirect_to' in result) reply.clearCookie('uoa_sso_link', { path: '/auth' });
    return reply.header('Cache-Control', 'no-store').send(result);
  });
  app.post('/auth/enterprise-link/personal-factor', { preHandler: [...preHandler, hintRate] }, async (request, reply) => {
    const body = z.object({ link_intent_id: Intent, email: z.string().trim().toLowerCase().email().max(320) }).strict().parse(request.body);
    if (!request.config || !request.configUrl) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
    return reply.header('Cache-Control', 'no-store').send(await startLinkPersonalFactor({
      linkIntentId: body.link_intent_id, email: body.email, browser: request.cookies.uoa_sso_link,
      config: request.config, configUrl: request.configUrl, ip: request.ip }));
  });
  app.post('/auth/enterprise-link/personal-factor/verify', { preHandler }, async (request, reply) => {
    const body = z.object({ link_intent_id: Intent, challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      code: z.string().min(1).max(64) }).strict().parse(request.body);
    if (!request.config || !request.configUrl) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
    const outcome = await verifyLinkPersonalFactor({ linkIntentId: body.link_intent_id, challenge: body.challenge,
      code: body.code, browser: request.cookies.uoa_sso_link, config: request.config, configUrl: request.configUrl, ip: request.ip });
    reply.clearCookie('uoa_sso_link', { path: '/auth' });
    return reply.header('Cache-Control', 'no-store').send(outcome);
  });
}
