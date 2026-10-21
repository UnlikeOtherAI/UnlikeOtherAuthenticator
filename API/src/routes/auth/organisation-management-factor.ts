import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPublicBaseUrl } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireSameOriginBrowserRequest } from '../../middleware/same-origin-browser.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { AppError } from '../../utils/errors.js';
import { hashAssuranceReference } from '../../services/session-assurance.service.js';
import { startManagementPersonalFactor, verifyManagementPersonalFactor } from '../../services/org-sso-management-factor.service.js';

export function registerOrganisationManagementFactor(app: FastifyInstance) {
  const rate = createRateLimiter({ keyBuilder: request => `management-factor:${request.ip}`, limit: 20, windowMs: 60000 });
  const hintRate = createRateLimiter({ keyBuilder: request => {
    const parsed = z.object({ email: z.string().max(320) }).passthrough().safeParse(request.body);
    return `management-factor-hint:${hashAssuranceReference(parsed.success ? parsed.data.email.trim().toLowerCase() : 'invalid')}`;
  }, limit: 6, windowMs: 60000 });
  const preHandler = [requireSameOriginBrowserRequest, rate, configVerifier];
  const cookies = { path: '/auth', httpOnly: true, sameSite: 'strict' as const,
    secure: new URL(getPublicBaseUrl()).protocol === 'https:' };
  app.post('/auth/organisation-access/personal-factor', { preHandler: [...preHandler, hintRate] }, async (request, reply) => {
    const body = z.object({ org_id: z.string().min(1).max(100), email: z.string().trim().toLowerCase().email().max(320),
      redirect_url: z.string().min(1).max(2048).optional(), code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: z.literal('S256'), state: z.string().max(2048).optional() }).strict().parse(request.body);
    if (!request.config || !request.configUrl) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
    const result = await startManagementPersonalFactor({ config: request.config, configUrl: request.configUrl,
      orgId: body.org_id, email: body.email, redirectUrl: body.redirect_url, codeChallenge: body.code_challenge,
      codeChallengeMethod: body.code_challenge_method, state: body.state }, request.adminDb);
    reply.setCookie('uoa_management_factor', result.browser, { ...cookies, maxAge: 300 });
    return reply.header('Cache-Control', 'no-store').send(result.response);
  });
  app.post('/auth/organisation-access/personal-factor/verify', { preHandler }, async (request, reply) => {
    const body = z.object({ challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().regex(/^\d{6}$/) }).strict().parse(request.body);
    if (!request.config || !request.configUrl) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
    const result = await verifyManagementPersonalFactor({ config: request.config, configUrl: request.configUrl,
      challenge: body.challenge, code: body.code, browser: request.cookies.uoa_management_factor }, request.adminDb);
    reply.clearCookie('uoa_management_factor', { path: '/auth' });
    reply.setCookie('uoa_management_intent', result.browser, { ...cookies, maxAge: 600 });
    return reply.header('Cache-Control', 'no-store').send({ ok: true, redirect_to: result.redirectTo });
  });
}
