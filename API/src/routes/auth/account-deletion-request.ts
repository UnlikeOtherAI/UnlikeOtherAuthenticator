import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import { z } from 'zod';

import { getPublicBaseUrl } from '../../config/env.js';
import { createKeyedRateLimiter, createRateLimiter } from '../../middleware/rate-limiter.js';
import { requireSameOriginBrowserRequest } from '../../middleware/same-origin-browser.js';
import { ACCOUNT_DELETION_PATH, ACCOUNT_DELETION_PROOF_SECONDS, confirmAccountDeletionRequest,
  startAccountDeletionRequest } from '../../services/account-deletion-request.service.js';
import { readAdminConfigJwt } from '../../services/admin-auth-config.service.js';
import { renderAuthEntrypointHtml, sendAuthHtml } from '../../services/auth-ui.service.js';
import { validateConfigFields } from '../../services/config.service.js';

const cookieName = 'uoa_account_deletion';
const Email = z.object({ email: z.string().trim().email().max(320) }).strict();
const Confirm = z.object({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
  twoFactorCode: z.string().regex(/^\d{6}$/).optional(),
}).strict();
const startLimit = createRateLimiter({ limit: 10, windowMs: 15 * 60_000,
  keyBuilder: request => `account-deletion-start:${request.ip}` });
const emailLimit = createKeyedRateLimiter({ limit: 3, windowMs: 15 * 60_000 });
const confirmLimit = createRateLimiter({ limit: 30, windowMs: 15 * 60_000,
  keyBuilder: request => `account-deletion-confirm:${request.ip}` });

export function registerAccountDeletionRequestRoutes(app: FastifyInstance): void {
  const root = ACCOUNT_DELETION_PATH;
  app.get(root, async (request, reply) => {
    const config = validateConfigFields(decodeJwt(readAdminConfigJwt()));
    const configUrl = new URL('/internal/admin/config', getPublicBaseUrl()).href;
    const html = await renderAuthEntrypointHtml({ config, configUrl,
      requestUrl: request.raw.url, cspNonce: reply.cspNonce?.script });
    reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex');
    return sendAuthHtml(reply, html);
  });

  app.post(`${root}/start`, { preHandler: [requireSameOriginBrowserRequest, startLimit] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { email } = Email.parse(request.body);
    emailLimit(`account-deletion-email:${email.toLowerCase()}`);
    const browser = randomBytes(32).toString('base64url');
    const result = await startAccountDeletionRequest(email, browser);
    reply.setCookie(cookieName, browser, { path: root, httpOnly: true, sameSite: 'strict',
      secure: new URL(getPublicBaseUrl()).protocol === 'https:', maxAge: ACCOUNT_DELETION_PROOF_SECONDS });
    return result;
  });

  app.post(`${root}/confirm`, { preHandler: [requireSameOriginBrowserRequest, confirmLimit] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const result = await confirmAccountDeletionRequest({ ...Confirm.parse(request.body), browser: request.cookies[cookieName] });
    reply.clearCookie(cookieName, { path: root, httpOnly: true, sameSite: 'strict',
      secure: new URL(getPublicBaseUrl()).protocol === 'https:' });
    return result;
  });
}
