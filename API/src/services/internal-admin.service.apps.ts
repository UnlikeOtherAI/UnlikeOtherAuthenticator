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
