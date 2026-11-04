import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { getEnv } from '../../config/env.js';
import { verifyPublicAccountToken, authorizePublicAccount } from '../../services/oauth/account.service.js';
import { settingVersion } from '../../services/setting-version.js';
import { settingsDelta } from '../../services/settings-delta.js';
import { SettingsNotifications, type SettingsTopic } from '../../services/settings-notifications.js';
import { SettingsStreamQueue } from '../../services/settings-stream-queue.js';
import { USER_SETTINGS_NAMESPACE_PATTERN, USER_SETTINGS_KEY_PATTERN } from '../../services/user-settings.service.js';
import { AppError } from '../../utils/errors.js';
import { requireMcpOAuthPublicProfile } from './public-profile-guard.js';

const paramsSchema = z.object({ namespace: z.string().regex(USER_SETTINGS_NAMESPACE_PATTERN), key: z.string().regex(USER_SETTINGS_KEY_PATTERN) });
const MAX_SOCKETS = 32; // Live Cloud Run request concurrency is 80; leave capacity for sign-in.

export function registerSettingsEvents(app: FastifyInstance): void {
  const lane = new SettingsStreamQueue();
  const subjects = new Map<string, number>();
  const reservations = new WeakMap<FastifyRequest, SettingsTopic>();
  const sockets = new Set<WebSocket>();
  let admitted = 0;
  let notifications: SettingsNotifications | undefined;
  const release = (userId: string) => {
    admitted -= 1;
    const remaining = (subjects.get(userId) ?? 1) - 1;
    if (remaining > 0) subjects.set(userId, remaining); else subjects.delete(userId);
  };
  const reserve = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Retry-After', '5');
    if (request.headers.upgrade?.toLowerCase() !== 'websocket') throw new AppError('BAD_REQUEST', 400, 'INVALID_REQUEST');
    const params = paramsSchema.parse(request.params);
    z.object({}).strict().parse(request.query);
    if (admitted >= MAX_SOCKETS) throw new AppError('SERVICE_UNAVAILABLE', 503, 'SETTINGS_STREAM_BUSY');
    admitted += 1;
    try {
      const account = await lane.run(() => verifyPublicAccountToken(request.headers.authorization, 'settings.read'));
      const count = subjects.get(account.userId) ?? 0;
      if (count >= 8) throw new AppError('SERVICE_UNAVAILABLE', 503, 'SETTINGS_STREAM_BUSY');
      if (request.raw.socket.destroyed) throw new Error('Connection closed');
      subjects.set(account.userId, count + 1);
      reservations.set(request, { userId: account.userId, ...params });
      request.raw.socket.once('close', () => {
        const pending = reservations.get(request);
        if (pending) { reservations.delete(request); release(pending.userId); }
      });
    } catch (error) { admitted -= 1; throw error; }
  };
  app.get('/oauth/me/settings/:namespace/:key/events', {
    websocket: true,
    preHandler: [requireMcpOAuthPublicProfile, reserve],
  }, (socket, request) => {
    const topic = reservations.get(request);
    if (!topic) { socket.close(1011); return; }
    reservations.delete(request);
    sockets.add(socket);
    let closed = false;
    let pending = false;
    let dirty = false;
    let ready = false;
    let previous: { value: unknown; version: string } | undefined;
    let unsubscribe: (() => void) | undefined;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      sockets.delete(socket);
      release(topic.userId);
      clearInterval(repair); clearTimeout(recycle);
      unsubscribe?.();
    };
    const check = () => {
      if (closed || !ready) return;
      if (pending) { dirty = true; return; }
      pending = true;
      void lane.run(async () => {
        if (closed) return;
        // Recheck current client/scopes as well as live subject authority.
        const account = await verifyPublicAccountToken(request.headers.authorization, 'settings.read');
        if (account.userId !== topic.userId) throw new Error('Subject changed');
        const value = await request.adminDb.$transaction(async tx => {
          await authorizePublicAccount(account, tx);
          const row = await tx.userSetting.findUnique({ where: { userId_namespace_key: topic }, select: { value: true } });
          return row?.value ?? null;
        });
        if (closed) return;
        const version = settingVersion(value);
        if (version === previous?.version) { socket.ping(); return; }
        if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013); return; }
        const frame = previous
          ? { type: 'settings.delta', protocolVersion: 1, namespace: topic.namespace, key: topic.key,
            baseVersion: previous.version, version, operation: settingsDelta(previous.value, value) }
          : { type: 'settings.snapshot', protocolVersion: 1, namespace: topic.namespace, key: topic.key, version, value };
        socket.send(JSON.stringify(frame), error => { if (error) socket.close(1011); });
        previous = { value, version };
      }).catch(() => { if (!closed) socket.close(1008); }).finally(() => {
        pending = false;
        if (dirty && !closed) { dirty = false; check(); }
      });
    };
    const repair = setInterval(check, 30_000);
    const recycle = setTimeout(() => socket.close(1000), 240_000 + Math.random() * 40_000);
    repair.unref(); recycle.unref();
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.on('message', () => socket.close(1008));
    void (async () => {
      const env = getEnv();
      const databaseUrl = env.DATABASE_ADMIN_URL ?? env.DATABASE_URL;
      if (!databaseUrl) throw new Error('Database unavailable');
      notifications ??= new SettingsNotifications(databaseUrl);
      unsubscribe = await notifications.subscribe(topic, check);
      if (closed) { unsubscribe(); return; }
      ready = true;
      check();
    })().catch(() => socket.close(1013));
  });
  app.addHook('onClose', async () => {
    sockets.forEach(socket => socket.close(1001));
    await notifications?.stop();
  });
}
