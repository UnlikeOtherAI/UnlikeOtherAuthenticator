import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMcpOAuthPublicProfile } from './public-profile-guard.js';
import { authorizePublicAccount, verifyPublicAccountToken } from '../../services/oauth/account.service.js';
import { resolveAvatar } from '../../services/avatar.service.js';
import { settingVersion } from '../../services/setting-version.js';
import { updateUserSettings, USER_SETTINGS_NAMESPACE_PATTERN, USER_SETTINGS_KEY_PATTERN } from '../../services/user-settings.service.js';
import { AppError } from '../../utils/errors.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';

const SettingParams = z.object({ namespace: z.string().regex(USER_SETTINGS_NAMESPACE_PATTERN), key: z.string().regex(USER_SETTINGS_KEY_PATTERN) });

export function registerOAuthAccountRoutes(app: FastifyInstance): void {
  const preHandler = [requireMcpOAuthPublicProfile, createRateLimiter({ limit: 120, windowMs: 60_000,
    keyBuilder: (request) => `oauth-account:${request.ip}` })];

  app.get('/oauth/me', { preHandler }, async (request, reply) => {
    const account = await verifyPublicAccountToken(request.headers.authorization, 'profile');
    const user = await request.adminDb.$transaction(async (tx) => {
      await authorizePublicAccount(account, tx);
      return tx.user.findUnique({ where: { id: account.userId }, select: { id: true, email: true, name: true } });
    });
    if (!user) throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
    reply.header('Cache-Control', 'no-store').send({ sub: user.id, email: user.email, name: user.name });
  });
  app.get('/oauth/me/avatar', { preHandler }, async (request, reply) => {
    const account = await verifyPublicAccountToken(request.headers.authorization, 'profile');
    await request.adminDb.$transaction((tx) => authorizePublicAccount(account, tx));
    const avatar = await resolveAvatar({ userId: account.userId, size: 96 });
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      .type(avatar.contentType).send(avatar.body);
  });
  app.get('/oauth/me/settings/:namespace/:key', { preHandler }, async (request, reply) => {
    const account = await verifyPublicAccountToken(request.headers.authorization, 'settings.read');
    const { namespace, key } = SettingParams.parse(request.params);
    const row = await request.adminDb.$transaction(async (tx) => {
      await authorizePublicAccount(account, tx);
      return tx.userSetting.findUnique({ where: { userId_namespace_key: { userId: account.userId, namespace, key } }, select: { value: true } });
    });
    const value = row?.value ?? null;
    reply.header('Cache-Control', 'no-store').header('ETag', settingVersion(value)).send({ value });
  });
  app.put('/oauth/me/settings/:namespace/:key', { preHandler }, async (request, reply) => {
    const account = await verifyPublicAccountToken(request.headers.authorization, 'settings.write');
    const { namespace, key } = SettingParams.parse(request.params);
    const { value } = z.object({ value: z.unknown().refine((item) => item !== undefined) }).strict().parse(request.body);
    const version = request.headers['if-match'];
    if (typeof version !== 'string' || !/^"[a-f0-9]{64}"$/.test(version)) throw new AppError('BAD_REQUEST', 428, 'SETTING_VERSION_REQUIRED');
    const updated = await updateUserSettings({ userId: account.userId, namespace, entries: { [key]: value } }, {
      prisma: request.adminDb, authorizeWrite: (tx) => authorizePublicAccount(account, tx), expectedVersion: { key, version },
    });
    const result = updated.settings[key] ?? null;
    reply.header('Cache-Control', 'no-store').header('ETag', settingVersion(result)).send({ value: result });
  });
}
