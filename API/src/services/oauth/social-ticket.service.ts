import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../../utils/errors.js';
import { getAdminPrisma } from '../../db/prisma.js';
import { PublicAuthorizationContext, type PublicContext } from './authorization-context.service.js';

const options = { secure: true, httpOnly: true, path: '/' };
const duration = 15 * 60_000;
const cookieName = (id: string) => `__Host-uoa-${id}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function isPublicSocialState(state: string): boolean { return /^native_[A-Za-z0-9_-]{32}$/.test(state); }
export async function startPublicSocialFlow(context: PublicContext, reply: FastifyReply) {
  const id = `native_${randomBytes(24).toString('base64url')}`;
  const browser = randomBytes(32).toString('base64url');
  const now = new Date();
  await getAdminPrisma().$transaction(async (tx) => {
    await tx.nativeOAuthFlow.deleteMany({ where: { expiresAt: { lt: now } } });
    await tx.nativeOAuthFlow.create({ data: { id, browserHash: hash(browser), context, expiresAt: new Date(now.getTime() + duration) } });
  });
  reply.setCookie(cookieName(id), browser, { ...options, sameSite: 'lax', maxAge: duration / 1000 });
  return id;
}
export async function readPublicFlow(request: FastifyRequest, id: string, db: Prisma.TransactionClient = getAdminPrisma()) {
  if (!isPublicSocialState(id)) throw new AppError('UNAUTHORIZED', 401);
  const browser = request.cookies[cookieName(id)];
  if (!browser || browser.length > 100) throw new AppError('UNAUTHORIZED', 401);
  const flow = await db.nativeOAuthFlow.findUnique({ where: { id } });
  if (!flow || flow.usedAt || flow.expiresAt.getTime() <= Date.now() ||
      !timingSafeEqual(Buffer.from(flow.browserHash), Buffer.from(hash(browser)))) throw new AppError('UNAUTHORIZED', 401);
  return { ...flow, context: PublicAuthorizationContext.parse(flow.context) };
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
