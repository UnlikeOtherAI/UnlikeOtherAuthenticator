import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { formatAdminApp, isDatabaseEnabled } from './internal-admin.service.base.js';

const appInclude = {
  org: { select: { id: true, name: true } },
  flags: true,
  killSwitches: true,
} as const;

const APP_PLATFORMS = new Set(['ios', 'android', 'web', 'macos', 'windows', 'linux', 'iot', 'tv', 'console', 'other']);
const OFFLINE_POLICIES = new Set(['allow', 'block', 'cached']);
const KILL_SWITCH_TYPES = new Set(['hard', 'soft', 'info', 'maintenance']);
const VERSION_FIELDS = new Set(['versionName', 'versionCode', 'buildNumber']);
const VERSION_OPERATORS = new Set(['lt', 'lte', 'eq', 'gte', 'gt', 'range']);
const VERSION_SCHEMES = new Set(['semver', 'integer', 'date', 'custom']);

function normalizeAppPlatform(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  if (!APP_PLATFORMS.has(normalized)) throw new AppError('BAD_REQUEST', 400, 'INVALID_APP_PLATFORM');
  return normalized;
}

function normalizeOfflinePolicy(policy: string | undefined): string {
  const normalized = policy?.trim().toLowerCase() || 'allow';
  if (!OFFLINE_POLICIES.has(normalized)) throw new AppError('BAD_REQUEST', 400, 'INVALID_OFFLINE_POLICY');
  return normalized;
}

export async function getAdminApps() {
  if (!isDatabaseEnabled()) return [];

  const prisma = getAdminPrisma();
  const apps = await prisma.app.findMany({
    orderBy: { createdAt: 'desc' },
    include: appInclude,
  });

  return apps.map(formatAdminApp);
}

export async function createAdminApp(input: {
  name: string;
  identifier: string;
  platform: string;
  domain: string;
  orgId: string;
  offlinePolicy?: string;
  pollIntervalSeconds?: number;
}) {
  const prisma = getAdminPrisma();
  const name = input.name.trim();
  const identifier = input.identifier.trim();
  const domain = normalizeDomain(input.domain);
  const orgId = input.orgId.trim();
  const platform = normalizeAppPlatform(input.platform);
  const offlinePolicy = normalizeOfflinePolicy(input.offlinePolicy);
  const pollIntervalSeconds = input.pollIntervalSeconds ?? 300;

  if (!name || name.length > 120 || !identifier || identifier.length > 160 || !domain || !orgId) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_APP_INPUT');
  }
  if (!Number.isInteger(pollIntervalSeconds) || pollIntervalSeconds < 30 || pollIntervalSeconds > 86400) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_POLL_INTERVAL');
  }

  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org) throw new AppError('BAD_REQUEST', 400, 'ORG_NOT_FOUND');

  const app = await prisma.app.create({
    data: {
      name,
      identifier,
      platform,
      domains: [domain],
      orgId,
      offlinePolicy,
      pollIntervalSeconds,
      featureFlagsEnabled: true,
    },
    include: appInclude,
  });

  return formatAdminApp(app);
}

export async function createAdminFeatureFlag(appId: string, input: {
  key: string;
  description?: string;
  defaultState: boolean;
}) {
  const prisma = getAdminPrisma();
  const app = await prisma.app.findUnique({ where: { id: appId }, select: { id: true } });
  if (!app) throw new AppError('NOT_FOUND', 404, 'APP_NOT_FOUND');

  await prisma.featureFlagDefinition.create({
    data: {
      appId,
      key: normalizeFlagKey(input.key),
      description: normalizeOptional(input.description, 500),
      defaultState: input.defaultState,
    },
  });

  return getAdminApp(appId);
}

export async function updateAdminFeatureFlag(appId: string, flagId: string, input: {
  key: string;
  description?: string;
  defaultState: boolean;
}) {
  const prisma = getAdminPrisma();
  const existing = await prisma.featureFlagDefinition.findFirst({ where: { id: flagId, appId }, select: { id: true } });
  if (!existing) throw new AppError('NOT_FOUND', 404, 'FLAG_NOT_FOUND');

  await prisma.featureFlagDefinition.update({
    where: { id: flagId },
    data: {
      key: normalizeFlagKey(input.key),
      description: normalizeOptional(input.description, 500),
      defaultState: input.defaultState,
    },
  });

  return getAdminApp(appId);
}

export async function deleteAdminFeatureFlag(appId: string, flagId: string) {
  const prisma = getAdminPrisma();
  const existing = await prisma.featureFlagDefinition.findFirst({ where: { id: flagId, appId }, select: { id: true } });
  if (!existing) throw new AppError('NOT_FOUND', 404, 'FLAG_NOT_FOUND');

  await prisma.featureFlagDefinition.delete({ where: { id: flagId } });
  return getAdminApp(appId);
}

export async function createAdminKillSwitch(appId: string, input: AdminKillSwitchInput) {
  const prisma = getAdminPrisma();
  const app = await prisma.app.findUnique({ where: { id: appId }, select: { id: true } });
  if (!app) throw new AppError('NOT_FOUND', 404, 'APP_NOT_FOUND');

  await prisma.killSwitchEntry.create({
    data: toKillSwitchData(appId, input),
  });

  return getAdminApp(appId);
}

export async function updateAdminKillSwitch(appId: string, killSwitchId: string, input: AdminKillSwitchInput) {
  const prisma = getAdminPrisma();
  const existing = await prisma.killSwitchEntry.findFirst({ where: { id: killSwitchId, appId }, select: { id: true } });
  if (!existing) throw new AppError('NOT_FOUND', 404, 'KILL_SWITCH_NOT_FOUND');

  await prisma.killSwitchEntry.update({
    where: { id: killSwitchId },
    data: toKillSwitchData(appId, input),
  });

  return getAdminApp(appId);
}

export async function deleteAdminKillSwitch(appId: string, killSwitchId: string) {
  const prisma = getAdminPrisma();
  const existing = await prisma.killSwitchEntry.findFirst({ where: { id: killSwitchId, appId }, select: { id: true } });
  if (!existing) throw new AppError('NOT_FOUND', 404, 'KILL_SWITCH_NOT_FOUND');

  await prisma.killSwitchEntry.delete({ where: { id: killSwitchId } });
  return getAdminApp(appId);
}

async function getAdminApp(appId: string) {
  const app = await getAdminPrisma().app.findUnique({
    where: { id: appId },
    include: appInclude,
  });
  if (!app) throw new AppError('NOT_FOUND', 404, 'APP_NOT_FOUND');
  return formatAdminApp(app);
}

function normalizeFlagKey(key: string): string {
  const normalized = key.trim();
  if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(normalized)) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_FLAG_KEY');
  }
  return normalized;
}

function normalizeOptional(value: string | undefined | null, maxLength: number): string | null {
  const normalized = value?.trim() ?? '';
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new AppError('BAD_REQUEST', 400, 'VALUE_TOO_LONG');
  return normalized;
}

type AdminKillSwitchInput = {
  name?: string;
  platform: string;
  type: string;
  versionField: string;
  operator: string;
  versionValue: string;
  versionMax?: string | null;
  versionScheme: string;
  latestVersion?: string | null;
  active: boolean;
  priority: number;
  cacheTtl?: number;
};

function normalizeEnum(value: string, allowed: Set<string>, code: string): string {
  const normalized = value.trim();
  if (!allowed.has(normalized)) throw new AppError('BAD_REQUEST', 400, code);
  return normalized;
}

function normalizeKillSwitchPlatform(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  if (normalized === 'both') return normalized;
  if (!APP_PLATFORMS.has(normalized)) throw new AppError('BAD_REQUEST', 400, 'INVALID_KILL_SWITCH_PLATFORM');
  return normalized;
}

function toKillSwitchData(appId: string, input: AdminKillSwitchInput) {
  const operator = normalizeEnum(input.operator, VERSION_OPERATORS, 'INVALID_OPERATOR');
  const versionMax = normalizeOptional(input.versionMax, 80);
  if (operator === 'range' && !versionMax) throw new AppError('BAD_REQUEST', 400, 'VERSION_MAX_REQUIRED');

  const priority = Math.trunc(input.priority);
  const cacheTtl = Math.trunc(input.cacheTtl ?? 3600);
  if (!Number.isFinite(priority) || priority < 0 || priority > 1000) throw new AppError('BAD_REQUEST', 400, 'INVALID_PRIORITY');
  if (!Number.isFinite(cacheTtl) || cacheTtl < 60 || cacheTtl > 86400) throw new AppError('BAD_REQUEST', 400, 'INVALID_CACHE_TTL');

  return {
    appId,
    name: normalizeOptional(input.name, 120),
    platform: normalizeKillSwitchPlatform(input.platform),
    type: normalizeEnum(input.type, KILL_SWITCH_TYPES, 'INVALID_KILL_SWITCH_TYPE'),
    versionField: normalizeEnum(input.versionField, VERSION_FIELDS, 'INVALID_VERSION_FIELD'),
    operator,
    versionValue: requireString(input.versionValue, 80, 'INVALID_VERSION_VALUE'),
    versionMax,
    versionScheme: normalizeEnum(input.versionScheme, VERSION_SCHEMES, 'INVALID_VERSION_SCHEME'),
    latestVersion: normalizeOptional(input.latestVersion, 80),
    active: input.active,
    priority,
    cacheTtl,
  };
}

function requireString(value: string, maxLength: number, code: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new AppError('BAD_REQUEST', 400, code);
  return normalized;
}
