import { getAdminPrisma } from '../../db/prisma.js';
import { ProductId } from '../../services/product-erasure-policy.service.js';
import { enabledProduct } from '../../services/product-erasure.service.js';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import { z } from 'zod';

import { getPublicBaseUrl } from '../../config/env.js';
import { createKeyedRateLimiter, createRateLimiter } from '../../middleware/rate-limiter.js';
import { requireSameOriginBrowserRequest } from '../../middleware/same-origin-browser.js';
import { ACCOUNT_DELETION_PATH, ACCOUNT_DELETION_PROOF_SECONDS, confirmAccountDeletionRequest,
  startAccountDeletionRequest, submitProductErasure } from '../../services/account-deletion-request.service.js';
import { readAdminConfigJwt } from '../../services/admin-auth-config.service.js';
import { renderAuthEntrypointHtml, sendAuthHtml } from '../../services/auth-ui.service.js';
import { validateConfigFields } from '../../services/config.service.js';

const cookieName = 'uoa_account_deletion';
const Email = z.object({ rejoin: z.boolean().optional(), product: ProductId.optional(), email: z.string().trim().email().max(320) }).strict();
const Confirm = z.object({
  rejoin: z.boolean().optional(), product: ProductId.optional(), challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
  password: z.string().min(1).max(1024).optional(),
  twoFactorCode: z.string().regex(/^\d{6}$/).optional(),
}).strict().refine(value => !value.password || Boolean(value.product));
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

  app.get(`${root}/receipt/:id`, { preHandler: [confirmLimit] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const job = await getAdminPrisma().productErasureJob.findUnique({ where: { id }, select: { completedAt: true, containerPreserved: true,
      receipts: { where: { outcome: 'RETAINED_EVIDENCE' }, select: { outcome: true }, take: 1 } } });
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('X-Robots-Tag','noindex');
    if (!job) return reply.code(404).type('text/plain').send('Receipt unavailable');
    const status = job.completedAt ? 'Deletion complete.' : 'Deletion in progress. Keep this link to check the result.';
    const details = [status, job.containerPreserved && 'The requested workspace was preserved.',
      job.receipts.length > 0 && 'Restricted evidence was retained.'].filter(Boolean);
    return reply.type('text/plain; charset=utf-8').send(details.join(' '));
  });
  app.get(`${root}/product/:id`, async (request, reply) => {
    const { id } = z.object({ id: ProductId }).parse(request.params);
    const { name, disclosure } = await enabledProduct(getAdminPrisma(), id);
    return reply.header('Cache-Control', 'no-store').send({ name, disclosure });
  });

  app.post(`${root}/submit-product`, { preHandler: [requireSameOriginBrowserRequest, confirmLimit] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const input = z.object({ product: ProductId, rejoin: z.boolean().optional(), challengeId: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/),
      container: z.object({ scope: z.enum(['TEAM','ORGANISATION']), id: z.string().min(1).max(256) }).strict().optional() }).strict().parse(request.body);
    return submitProductErasure({ ...input, browser: request.cookies[cookieName] });
  });
  app.post(`${root}/start`, { preHandler: [requireSameOriginBrowserRequest, startLimit] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { email, product, rejoin } = Email.parse(request.body);
    emailLimit(`account-deletion-email:${email.toLowerCase()}`);
    const browser = randomBytes(32).toString('base64url');
    const result = await startAccountDeletionRequest(email, browser, product, rejoin);
    reply.setCookie(cookieName, browser, { path: root, httpOnly: true, sameSite: 'strict',
      secure: new URL(getPublicBaseUrl()).protocol === 'https:', maxAge: ACCOUNT_DELETION_PROOF_SECONDS });
    return result;
  });

  app.post(`${root}/confirm`, { preHandler: [requireSameOriginBrowserRequest, confirmLimit] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const result = await confirmAccountDeletionRequest({ ...Confirm.parse(request.body), browser: request.cookies[cookieName] });
    if ('submitted' in result) reply.clearCookie(cookieName, { path: root, httpOnly: true, sameSite: 'strict',
      secure: new URL(getPublicBaseUrl()).protocol === 'https:' });
    return result;
  });
}
