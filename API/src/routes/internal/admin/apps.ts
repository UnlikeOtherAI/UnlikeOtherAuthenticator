import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  createAdminApp,
  createAdminFeatureFlag,
  createAdminKillSwitch,
  deleteAdminFeatureFlag,
  deleteAdminKillSwitch,
  updateAdminFeatureFlag,
  updateAdminKillSwitch,
} from '../../../services/internal-admin.service.js';
import { normalizeDomain } from '../../../utils/domain.js';

const AppParamsSchema = z.object({ appId: z.string().trim().min(1) });
const FlagParamsSchema = z.object({
  appId: z.string().trim().min(1),
  flagId: z.string().trim().min(1),
});
const KillSwitchParamsSchema = z.object({
  appId: z.string().trim().min(1),
  killSwitchId: z.string().trim().min(1),
});
const CreateAppSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    identifier: z.string().trim().min(1).max(160),
    platform: z.enum(['ios', 'android', 'web', 'macos', 'windows', 'linux', 'iot', 'tv', 'console', 'other']),
    domain: z.string().trim().min(3).transform(normalizeDomain),
    org_id: z.string().trim().min(1),
    offline_policy: z.enum(['allow', 'block', 'cached']).optional(),
    poll_interval_seconds: z.number().int().min(30).max(86400).optional(),
  })
  .strict();
const FeatureFlagSchema = z
  .object({
    key: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
    default_state: z.boolean(),
  })
  .strict();
const KillSwitchSchema = z
  .object({
    name: z.string().trim().max(120).optional(),
    platform: z.string().trim().min(1).max(20),
    type: z.enum(['hard', 'soft', 'info', 'maintenance']),
    version_field: z.enum(['versionName', 'versionCode', 'buildNumber']),
    operator: z.enum(['lt', 'lte', 'eq', 'gte', 'gt', 'range']),
    version_value: z.string().trim().min(1).max(80),
    version_max: z.string().trim().max(80).nullable().optional(),
    version_scheme: z.enum(['semver', 'integer', 'date', 'custom']),
    latest_version: z.string().trim().max(80).nullable().optional(),
    active: z.boolean(),
    priority: z.number().int().min(0).max(1000),
    cache_ttl: z.number().int().min(60).max(86400).optional(),
  })
  .strict();

const objectSchema = { type: 'object', additionalProperties: true } as const;

function adminRoute(responseSchema: Record<string, unknown>): RouteShorthandOptions {
  return {
    preHandler: [requireAdminSuperuser],
    schema: { response: { 200: responseSchema } },
  };
}

export function registerInternalAdminAppRoutes(app: FastifyInstance): void {
  app.post('/internal/admin/apps', adminRoute(objectSchema), async (request) => {
    const body = CreateAppSchema.parse(request.body);
    return createAdminApp({
      name: body.name,
      identifier: body.identifier,
      platform: body.platform,
      domain: body.domain,
      orgId: body.org_id,
      offlinePolicy: body.offline_policy,
      pollIntervalSeconds: body.poll_interval_seconds,
    });
  });

  app.post('/internal/admin/apps/:appId/flags', adminRoute(objectSchema), async (request) => {
    const { appId } = AppParamsSchema.parse(request.params);
    const body = FeatureFlagSchema.parse(request.body);
    return createAdminFeatureFlag(appId, {
      key: body.key,
      description: body.description,
      defaultState: body.default_state,
    });
  });

  app.patch('/internal/admin/apps/:appId/flags/:flagId', adminRoute(objectSchema), async (request) => {
    const { appId, flagId } = FlagParamsSchema.parse(request.params);
    const body = FeatureFlagSchema.parse(request.body);
    return updateAdminFeatureFlag(appId, flagId, {
      key: body.key,
      description: body.description,
      defaultState: body.default_state,
    });
  });

  app.delete('/internal/admin/apps/:appId/flags/:flagId', adminRoute(objectSchema), async (request) => {
    const { appId, flagId } = FlagParamsSchema.parse(request.params);
    return deleteAdminFeatureFlag(appId, flagId);
  });

  app.post('/internal/admin/apps/:appId/kill-switches', adminRoute(objectSchema), async (request) => {
    const { appId } = AppParamsSchema.parse(request.params);
    const body = KillSwitchSchema.parse(request.body);
    return createAdminKillSwitch(appId, toKillSwitchInput(body));
  });

  app.patch('/internal/admin/apps/:appId/kill-switches/:killSwitchId', adminRoute(objectSchema), async (request) => {
    const { appId, killSwitchId } = KillSwitchParamsSchema.parse(request.params);
    const body = KillSwitchSchema.parse(request.body);
    return updateAdminKillSwitch(appId, killSwitchId, toKillSwitchInput(body));
  });

  app.delete('/internal/admin/apps/:appId/kill-switches/:killSwitchId', adminRoute(objectSchema), async (request) => {
    const { appId, killSwitchId } = KillSwitchParamsSchema.parse(request.params);
    return deleteAdminKillSwitch(appId, killSwitchId);
  });
}

function toKillSwitchInput(body: z.infer<typeof KillSwitchSchema>) {
  return {
    name: body.name,
    platform: body.platform,
    type: body.type,
    versionField: body.version_field,
    operator: body.operator,
    versionValue: body.version_value,
    versionMax: body.version_max,
    versionScheme: body.version_scheme,
    latestVersion: body.latest_version,
    active: body.active,
    priority: body.priority,
    cacheTtl: body.cache_ttl,
  };
}
