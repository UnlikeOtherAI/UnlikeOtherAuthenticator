import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getPublicBaseUrl } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireSameOriginBrowserRequest } from '../../middleware/same-origin-browser.js';
import { pendingRegistrationState, startPendingRegistration, verifyPendingRegistrationCode, verifyPendingRegistrationLink } from '../../services/pending-registration.service.js';
import { registrationCookieName, REGISTRATION_TTL_MS } from '../../services/registration-credentials.js';
import { renderRegistrationLinkPage } from '../../services/registration-link-page.service.js';
import { registerRateLimiter, tokenConsumeRateLimiter, verifyCodeRateLimiter } from './rate-limit-keys.js';
import { registrationContext } from './registration-context.js';
import { recordAuthFunnelStep } from '../../services/auth-funnel.service.js';

const idSchema = z.string().uuid();
const codeBody = z.object({ id: idSchema, code: z.string().max(64) }).strict();

export function registerPendingRegistrationRoutes(app: FastifyInstance): void {
  app.post('/auth/registration/start', {
    preHandler: [requireSameOriginBrowserRequest, registerRateLimiter, configVerifier],
  }, async (request, reply) => {
    const parsed = z.object({ email: z.string().trim().toLowerCase().email() }).strict().safeParse(request.body);
    const context = registrationContext(request);
    await recordAuthFunnelStep({ domain: context.config.domain, step: 'register_submitted', outcome: parsed.success ? 'valid_email' : 'invalid_email' }, { prisma: request.adminDb });
    let result: Awaited<ReturnType<typeof startPendingRegistration>>;
    try {
      result = await startPendingRegistration({ ...context, email: parsed.success ? parsed.data.email : null, ip: request.ip }, request.adminDb);
    } catch (error) {
      await recordAuthFunnelStep({ domain: context.config.domain, step: 'registration_email', outcome: 'error' }, { prisma: request.adminDb });
      throw error;
    }
    const delivery = result.status === 'existing_user' ? 'existing_user_inline' : result.delivery;
    if (delivery) await recordAuthFunnelStep({ domain: context.config.domain, step: 'registration_email', outcome: delivery }, { prisma: request.adminDb });
    reply.header('Cache-Control', 'no-store');
    if (result.status === 'existing_user') return reply.code(409).send({ error: 'Request failed', code: 'EMAIL_ALREADY_REGISTERED' });
    reply.setCookie(registrationCookieName(result.id), result.credential, {
      httpOnly: true, secure: new URL(getPublicBaseUrl()).protocol === 'https:',
      sameSite: 'lax', path: '/auth', maxAge: REGISTRATION_TTL_MS / 1000,
    });
    return { message: 'We sent instructions to your email', registration_id: result.id, expires_at: result.expiresAt.toISOString() };
  });

  app.get('/auth/registration/status', {
    preHandler: [requireSameOriginBrowserRequest, configVerifier],
  }, async (request, reply) => {
    const { id } = z.object({ id: idSchema }).parse(request.query);
    reply.header('Cache-Control', 'no-store');
    return pendingRegistrationState({ ...registrationContext(request), id,
      credential: request.cookies[registrationCookieName(id)] ?? '' }, request.adminDb);
  });

  app.post('/auth/registration/code', {
    preHandler: [requireSameOriginBrowserRequest, verifyCodeRateLimiter, configVerifier],
  }, async (request, reply) => {
    const { id, code } = codeBody.parse(request.body);
    const context = { ...registrationContext(request), id, credential: request.cookies[registrationCookieName(id)] ?? '' };
    await verifyPendingRegistrationCode({ ...context, code: code.toUpperCase() }, request.adminDb);
    reply.header('Cache-Control', 'no-store');
    return pendingRegistrationState(context, request.adminDb);
  });

  app.get('/auth/registration/link', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${reply.cspNonce?.script}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    return reply.type('text/html; charset=utf-8').send(renderRegistrationLinkPage(reply.cspNonce?.script ?? ''));
  });
  app.post('/auth/registration/link', {
    preHandler: [requireSameOriginBrowserRequest, tokenConsumeRateLimiter],
  }, async (request, reply) => {
    const { token } = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(request.body);
    await verifyPendingRegistrationLink(token, request.adminDb);
    reply.header('Cache-Control', 'no-store');
    return { status: 'verified' };
  });
}
