import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  USER_SETTINGS_MAX_ENTRIES,
  USER_SETTINGS_MAX_TOTAL_BYTES,
  USER_SETTINGS_MAX_VALUE_BYTES,
} from '../../config/constants.js';
import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { requireUserAccessTokenForDomainQuery } from '../../middleware/user-access-token.js';
import {
  deleteUserSetting,
  deleteUserSettingsNamespace,
  getUserSetting,
  getUserSettingsNamespace,
  listUserSettings,
  updateUserSettings,
  USER_SETTINGS_KEY_PATTERN,
  USER_SETTINGS_NAMESPACE_PATTERN,
  type NamespaceSettings,
} from '../../services/user-settings.service.js';
import { normalizeDomain } from '../../utils/domain.js';
import { AppError } from '../../utils/errors.js';

const QuerySchema = z.object({ domain: z.string().trim().min(1) }).strict();

const Namespace = z.string().regex(USER_SETTINGS_NAMESPACE_PATTERN);
const Key = z.string().regex(USER_SETTINGS_KEY_PATTERN);

const NamespaceParamsSchema = z.object({ namespace: Namespace }).strict();
const KeyParamsSchema = z.object({ namespace: Namespace, key: Key }).strict();

// `value` is any JSON value except `null`; the service does the deep validation and sizing.
const PutBodySchema = z
  .object({ value: z.unknown().refine((value) => value !== undefined && value !== null) })
  .strict();

// `null` deletes that key. Key count bounds are enforced by the service.
const PatchBodySchema = z.object({ settings: z.record(Key, z.unknown()) }).strict();

// One maximum-size value plus room for its JSON envelope. A PATCH carrying several values shares
// this budget; the per-user quota is enforced separately after the write.
const SETTINGS_BODY_LIMIT = USER_SETTINGS_MAX_VALUE_BYTES + 16 * 1024;

// Dual auth, exactly as `/avatar/me`: the domain-hash bearer authenticates the product backend,
// the access token establishes which user it is acting for (Docs/Auth/user-settings.md §5).
const dualAuth = [requireDomainHashAuthForDomainQuery, requireUserAccessTokenForDomainQuery];

const mutationRateLimit = createRateLimiter({
  keyBuilder: (request: FastifyRequest) => {
    const query = QuerySchema.safeParse(request.query);
    const domain = query.success ? normalizeDomain(query.data.domain) : 'unknown';
    return `settings-me-write:${domain}:${request.accessTokenClaims?.userId ?? 'unknown'}`;
  },
  limit: 600,
  windowMs: 60 * 60 * 1000,
});

/** The acting identity is always the access-token subject — never a path or body value. */
function actingUserId(request: FastifyRequest): string {
  const userId = request.accessTokenClaims?.userId;
  if (!userId) throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
  return userId;
}

/** Settings are per-user data: never let an intermediary cache them. */
function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
}

function namespaceResponse(result: NamespaceSettings) {
  return {
    ok: true,
    namespace: result.namespace,
    settings: result.settings,
    updated_at: result.updatedAt?.toISOString() ?? null,
  };
}

export function registerUserSettingsMeRoutes(app: FastifyInstance): void {
  app.get('/settings/me', { preHandler: dualAuth }, async (request, reply) => {
    QuerySchema.parse(request.query);
    const result = await listUserSettings({ userId: actingUserId(request) });

    noStore(reply);
    return {
      ok: true,
      namespaces: result.namespaces,
      usage: {
        entries: result.usage.entries,
        size_bytes: result.usage.sizeBytes,
        max_entries: USER_SETTINGS_MAX_ENTRIES,
        max_size_bytes: USER_SETTINGS_MAX_TOTAL_BYTES,
      },
    };
  });

  app.get('/settings/me/:namespace', { preHandler: dualAuth }, async (request, reply) => {
    QuerySchema.parse(request.query);
    const { namespace } = NamespaceParamsSchema.parse(request.params);

    noStore(reply);
    return namespaceResponse(
      await getUserSettingsNamespace({ userId: actingUserId(request), namespace }),
    );
  });

  app.patch(
    '/settings/me/:namespace',
    { bodyLimit: SETTINGS_BODY_LIMIT, preHandler: [...dualAuth, mutationRateLimit] },
    async (request, reply) => {
      QuerySchema.parse(request.query);
      const { namespace } = NamespaceParamsSchema.parse(request.params);
      const body = PatchBodySchema.parse(request.body);

      noStore(reply);
      return namespaceResponse(
        await updateUserSettings({
          userId: actingUserId(request),
          namespace,
          entries: body.settings,
        }),
      );
    },
  );

  app.delete(
    '/settings/me/:namespace',
    { preHandler: [...dualAuth, mutationRateLimit] },
    async (request) => {
      QuerySchema.parse(request.query);
      const { namespace } = NamespaceParamsSchema.parse(request.params);

      const deleted = await deleteUserSettingsNamespace({
        userId: actingUserId(request),
        namespace,
      });
      return { ok: true, deleted };
    },
  );

  app.get('/settings/me/:namespace/:key', { preHandler: dualAuth }, async (request, reply) => {
    QuerySchema.parse(request.query);
    const { namespace, key } = KeyParamsSchema.parse(request.params);
    const entry = await getUserSetting({ userId: actingUserId(request), namespace, key });

    noStore(reply);
    return {
      ok: true,
      namespace: entry.namespace,
      key: entry.key,
      value: entry.value,
      updated_at: entry.updatedAt.toISOString(),
    };
  });

  app.put(
    '/settings/me/:namespace/:key',
    { bodyLimit: SETTINGS_BODY_LIMIT, preHandler: [...dualAuth, mutationRateLimit] },
    async (request, reply) => {
      QuerySchema.parse(request.query);
      const { namespace, key } = KeyParamsSchema.parse(request.params);
      const body = PutBodySchema.parse(request.body);

      const result = await updateUserSettings({
        userId: actingUserId(request),
        namespace,
        entries: { [key]: body.value },
      });

      noStore(reply);
      return {
        ok: true,
        namespace: result.namespace,
        key,
        value: result.settings[key],
        updated_at: result.updatedAt?.toISOString() ?? null,
      };
    },
  );

  app.delete(
    '/settings/me/:namespace/:key',
    { preHandler: [...dualAuth, mutationRateLimit] },
    async (request) => {
      QuerySchema.parse(request.query);
      const { namespace, key } = KeyParamsSchema.parse(request.params);

      await deleteUserSetting({ userId: actingUserId(request), namespace, key });
      return { ok: true };
    },
  );
}
