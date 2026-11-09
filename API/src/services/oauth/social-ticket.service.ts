import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../../utils/errors.js';
import { getAdminPrisma } from '../../db/prisma.js';
import { SocialProviderSchema, type SocialProviderKey } from '../social/provider.base.js';
import { z } from 'zod';
import { PublicAuthorizationContext, type PublicContext } from './authorization-context.service.js';

const options = { secure: true, httpOnly: true, path: '/' };
const duration = 15 * 60_000;
const cookieName = (id: string) => `__Host-uoa-${id}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function isPublicSocialState(state: string): boolean { return /^native_[A-Za-z0-9_-]{32}$/.test(state); }
const StoredContext = PublicAuthorizationContext.extend({
  provider: SocialProviderSchema.default('google'),
  code_verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
});
export async function startPublicSocialFlow(context: PublicContext, reply: FastifyReply,
  provider: SocialProviderKey = 'google', codeVerifier?: string) {
  const id = `native_${randomBytes(24).toString('base64url')}`;
  const browser = randomBytes(32).toString('base64url');
  const now = new Date();
  await getAdminPrisma().$transaction(async (tx) => {
    await tx.nativeOAuthFlow.create({ data: { id, browserHash: hash(browser), context: { ...context, provider, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) }, expiresAt: new Date(now.getTime() + duration) } });
  });
  reply.setCookie(cookieName(id), browser, { ...options, sameSite: provider === 'apple' ? 'none' : 'lax', maxAge: duration / 1000 });
  return id;
}
export async function readPublicFlow(request: FastifyRequest, id: string, db: Prisma.TransactionClient = getAdminPrisma()) {
  if (!isPublicSocialState(id)) throw new AppError('UNAUTHORIZED', 401);
  const browser = request.cookies[cookieName(id)];
  if (!browser || browser.length > 100) throw new AppError('UNAUTHORIZED', 401);
  const flow = await db.nativeOAuthFlow.findUnique({ where: { id } });
  if (!flow || flow.usedAt || flow.expiresAt.getTime() <= Date.now() ||
      !timingSafeEqual(Buffer.from(flow.browserHash), Buffer.from(hash(browser)))) throw new AppError('UNAUTHORIZED', 401);
  const { provider, code_verifier: codeVerifier, ...context } = StoredContext.parse(flow.context);
  return { ...flow, context, provider, codeVerifier };
}
export async function readPublicCompletion(request: FastifyRequest, id: string, db?: Prisma.TransactionClient) {
  const flow = await readPublicFlow(request, id, db);
  if (!flow.userId || flow.credentialEpoch === null || !flow.callbackUsedAt) throw new AppError('UNAUTHORIZED', 401);
  return { ...flow, userId: flow.userId, credentialEpoch: flow.credentialEpoch };
}
export function bindPublicCompletion(request: FastifyRequest, reply: FastifyReply, id: string) {
  const browser = request.cookies[cookieName(id)];
  if (!browser) throw new AppError('UNAUTHORIZED', 401);
  reply.setCookie(cookieName(id), browser, { ...options, sameSite: 'strict', maxAge: duration / 1000 });
}
export function clearPublicCompletion(reply: FastifyReply, id: string) { reply.clearCookie(cookieName(id), options); }
