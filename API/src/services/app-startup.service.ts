import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';

type StartupPrisma = Pick<
  PrismaClient,
  | 'app'
  | 'featureFlagDefinition'
  | 'featureFlagUserOverride'
  | 'killSwitchEntry'
  | 'orgMember'
>;

type StartupDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma: StartupPrisma;
};

type StartupParams = {
  domain: string;
  appIdentifier: string;
  platform: 'ios' | 'android' | 'web' | 'macos' | 'windows' | 'other';
  versionName?: string;
  versionCode?: string;
  buildNumber?: string;
  userId?: string;
};

type KillSwitchResponse = {
  id: string;
  type: string;
  titleKey: string | null;
  title: string | null;
  messageKey: string | null;
  message: string | null;
  primaryButtonKey: string | null;
  primaryButton: string | null;
  secondaryButtonKey: string | null;
  secondaryButton: string | null;
  storeUrl: string | null;
  latestVersion: string | null;
  cacheTtl: number;
};

export type AppStartupResponse = {
  killSwitch: KillSwitchResponse | null;
  flags: Record<string, boolean>;
  cacheTtl: number;
  serverTime: string;
  activatesIn?: number;
};

type AppRow = NonNullable<Awaited<ReturnType<StartupPrisma['app']['findFirst']>>>;
type KillSwitchRow = Awaited<ReturnType<StartupPrisma['killSwitchEntry']['findMany']>>[number];

const DEFAULT_CACHE_TTL = 3600;
const SOON_ACTIVATION_SECONDS = 900;

function emptyStartup(now = new Date()): AppStartupResponse {
  return {
    killSwitch: null,
    flags: {},
    cacheTtl: DEFAULT_CACHE_TTL,
    serverTime: now.toISOString(),
  };
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function versionForField(entry: KillSwitchRow, params: StartupParams): string | undefined {
  if (entry.versionField === 'versionName') return params.versionName;
  if (entry.versionField === 'versionCode') return params.versionCode;
  if (entry.versionField === 'buildNumber') return params.buildNumber;
  return undefined;
}

function compareSemver(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .split(/[.+-]/)
      .slice(0, 4)
      .map((part) => {
        const number = Number.parseInt(part, 10);
        return Number.isFinite(number) ? number : 0;
      });
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function compareVersions(a: string, b: string, scheme: string): number {
  if (scheme === 'integer') {
    const diff = Number.parseInt(a, 10) - Number.parseInt(b, 10);
    if (Number.isFinite(diff) && diff !== 0) return diff > 0 ? 1 : -1;
    return 0;
  }
  if (scheme === 'date') {
    const normalize = (value: string) => value.replaceAll('.', '').replaceAll('-', '');
    return normalize(a).localeCompare(normalize(b));
  }
  if (scheme === 'semver') return compareSemver(a, b);
  return a.localeCompare(b);
}

function versionMatches(entry: KillSwitchRow, params: StartupParams): boolean {
  if (entry.type === 'maintenance') return true;

  const value = versionForField(entry, params);
  if (!value) return false;

  const compared = compareVersions(value, entry.versionValue, entry.versionScheme);
  if (entry.operator === 'lt') return compared < 0;
  if (entry.operator === 'lte') return compared <= 0;
  if (entry.operator === 'gt') return compared > 0;
  if (entry.operator === 'gte') return compared >= 0;
  if (entry.operator === 'range') {
    if (!entry.versionMax) return false;
    return compared >= 0 && compareVersions(value, entry.versionMax, entry.versionScheme) <= 0;
  }
  return compared === 0;
}

function platformMatches(entry: KillSwitchRow, platform: StartupParams['platform']): boolean {
  return entry.platform === 'both' || entry.platform === platform;
}

function isTestUser(entry: KillSwitchRow, userId: string | undefined): boolean {
  return Boolean(userId && jsonStringArray(entry.testUserIds).includes(userId));
}

function activeNow(entry: KillSwitchRow, now: Date, userId: string | undefined): boolean {
  if (isTestUser(entry, userId)) return !entry.deactivateAt || entry.deactivateAt > now;
  if (!entry.active) return false;
  if (entry.activateAt && entry.activateAt > now) return false;
  if (entry.deactivateAt && entry.deactivateAt <= now) return false;
  return true;
}

function selectKillSwitch(
  entries: KillSwitchRow[],
  params: StartupParams,
  now: Date,
): { selected: KillSwitchRow | null; activatesIn?: number } {
  const matchingVersion = entries.filter(
    (entry) => platformMatches(entry, params.platform) && versionMatches(entry, params),
  );
  const activeEntries = matchingVersion.filter((entry) => activeNow(entry, now, params.userId));
  activeEntries.sort((a, b) => {
    const priority = b.priority - a.priority;
    if (priority !== 0) return priority;
    const created = a.createdAt.getTime() - b.createdAt.getTime();
    if (created !== 0) return created;
    return a.id.localeCompare(b.id);
  });

  const futureActivations = matchingVersion.flatMap((entry) => {
    if (!entry.active || !entry.activateAt || entry.activateAt <= now) return [];
    const seconds = Math.ceil((entry.activateAt.getTime() - now.getTime()) / 1000);
    return seconds > 0 ? [seconds] : [];
  });
  const activatesIn = futureActivations.length ? Math.min(...futureActivations) : undefined;

  return { selected: activeEntries[0] ?? null, activatesIn };
}

function toKillSwitchResponse(entry: KillSwitchRow, app: AppRow): KillSwitchResponse {
  return {
    id: entry.id,
    type: entry.type,
    titleKey: entry.titleKey,
    title: entry.title,
    messageKey: entry.messageKey,
    message: entry.message,
    primaryButtonKey: entry.primaryButtonKey,
    primaryButton: entry.primaryButton,
    secondaryButtonKey: entry.secondaryButtonKey,
    secondaryButton: entry.secondaryButton,
    storeUrl: entry.storeUrl ?? app.storeUrl,
    latestVersion: entry.latestVersion,
    cacheTtl: entry.cacheTtl,
  };
}

async function resolveFlags(
  app: AppRow,
  params: StartupParams,
  deps: StartupDeps,
): Promise<Record<string, boolean>> {
  if (!app.featureFlagsEnabled) return {};

  const definitions = await deps.prisma.featureFlagDefinition.findMany({
    where: { appId: app.id },
    orderBy: { createdAt: 'asc' },
    select: { key: true, defaultState: true },
  });
  const flags = Object.fromEntries(definitions.map((flag) => [flag.key, flag.defaultState]));
  if (!params.userId || definitions.length === 0) return flags;

  const membership = await deps.prisma.orgMember.findFirst({
    where: { orgId: app.orgId, userId: params.userId },
    select: { id: true },
  });
  if (!membership) return flags;

  const overrides = await deps.prisma.featureFlagUserOverride.findMany({
    where: {
      appId: app.id,
      userId: params.userId,
      flagKey: { in: definitions.map((flag) => flag.key) },
    },
    select: { flagKey: true, value: true },
  });
  for (const override of overrides) {
    flags[override.flagKey] = override.value;
  }

  return flags;
}

export async function getAppStartup(
  params: StartupParams,
  deps: StartupDeps,
): Promise<AppStartupResponse> {
  const now = new Date();
  const env = deps.env ?? getEnv();
  if (!env.DATABASE_URL) return emptyStartup(now);

  const app = await deps.prisma.app.findFirst({
    where: {
      identifier: normalizeIdentifier(params.appIdentifier),
      org: { domain: normalizeDomain(params.domain) },
    },
  });
  if (!app?.active) return emptyStartup(now);

  const [flags, killSwitchEntries] = await Promise.all([
    resolveFlags(app, params, deps),
    deps.prisma.killSwitchEntry.findMany({ where: { appId: app.id } }),
  ]);

  const { selected, activatesIn } = selectKillSwitch(killSwitchEntries, params, now);
  const cacheTtl = selected
    ? selected.cacheTtl
    : activatesIn && activatesIn <= SOON_ACTIVATION_SECONDS
      ? Math.min(DEFAULT_CACHE_TTL, activatesIn)
      : DEFAULT_CACHE_TTL;
  const response: AppStartupResponse = {
    killSwitch: selected ? toKillSwitchResponse(selected, app) : null,
    flags,
    cacheTtl,
    serverTime: now.toISOString(),
  };
  if (activatesIn !== undefined && activatesIn <= SOON_ACTIVATION_SECONDS) {
    response.activatesIn = activatesIn;
  }
  return response;
}
