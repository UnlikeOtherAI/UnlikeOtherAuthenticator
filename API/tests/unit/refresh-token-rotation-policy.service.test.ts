import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { createRefreshTokenRotationPolicyGuard } from '../../src/services/refresh-token-rotation-policy.service.js';
import { makeConfig } from './helpers/token-service-test-helpers.js';

const source = { orgId: 'org-source', teamId: 'team-source' };
const target = { orgId: 'org-target', teamId: 'team-target' };
const row = {
  userId: 'user-1',
  domain: 'client.example.com',
  ...source,
  twoFaCompleted: false,
};

function makePrisma(params?: {
  activeOrgs?: string[];
  activeTeams?: string[];
  targetPolicy?: 'OFF' | 'OPTIONAL' | 'REQUIRED' | null;
  twoFaEnabled?: boolean;
}) {
  const activeOrgs = new Set(params?.activeOrgs ?? [source.orgId, target.orgId]);
  const activeTeams = new Set(params?.activeTeams ?? [source.teamId, target.teamId]);
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
    orgMember: {
      findFirst: vi.fn(async ({ where }: { where: { orgId: string } }) =>
        activeOrgs.has(where.orgId) ? { id: `member-${where.orgId}` } : null,
      ),
    },
    teamMember: {
      findFirst: vi.fn(async ({ where }: { where: { teamId: string } }) =>
        activeTeams.has(where.teamId) ? { id: `member-${where.teamId}` } : null,
      ),
    },
    clientDomain: {
      findUnique: vi.fn().mockResolvedValue({ twoFaPolicy: 'OPTIONAL' }),
    },
    organisation: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({ twoFaPolicy: params?.targetPolicy ?? null }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ twoFaEnabled: params?.twoFaEnabled ?? false }),
    },
    domainSignatureSettings: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  } as unknown as PrismaClient;
}

function switchGuard(prisma: PrismaClient, validateSource = true) {
  return createRefreshTokenRotationPolicyGuard({
    prisma,
    targetWorkspace: target,
    targetWorkspaceError: 'WORKSPACE_NOT_AVAILABLE',
    validateSource,
    twoFa: {
      config: { ...makeConfig(), '2fa_enabled': true },
      error: 'INTERACTION_REQUIRED',
    },
  });
}

describe('refresh-token workspace-switch policy guard', () => {
  it('locks both exact memberships before checking 2FA and signature policy', async () => {
    const prisma = makePrisma({ twoFaEnabled: true });
    const afterWorkspaceLock = vi.fn().mockResolvedValue(undefined);
    const guard = createRefreshTokenRotationPolicyGuard({
      prisma,
      targetWorkspace: target,
      targetWorkspaceError: 'WORKSPACE_NOT_AVAILABLE',
      afterWorkspaceLock,
      twoFa: {
        config: { ...makeConfig(), '2fa_enabled': true },
        error: 'INTERACTION_REQUIRED',
      },
    });

    await expect(guard({ ...row, twoFaCompleted: true })).resolves.toBeUndefined();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
    expect(afterWorkspaceLock).toHaveBeenCalledOnce();
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: row.userId },
      select: { twoFaEnabled: true },
    });
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
  });

  it('maps only target eligibility failures to WORKSPACE_NOT_AVAILABLE', async () => {
    const targetMissing = makePrisma({ activeTeams: [source.teamId] });
    await expect(switchGuard(targetMissing)(row)).rejects.toMatchObject({
      statusCode: 403,
      message: 'WORKSPACE_NOT_AVAILABLE',
    });
    expect(targetMissing.user.findUnique).not.toHaveBeenCalled();

    const sourceMissing = makePrisma({ activeTeams: [target.teamId] });
    await expect(switchGuard(sourceMissing)(row)).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_REFRESH_TOKEN',
    });
    expect(sourceMissing.user.findUnique).not.toHaveBeenCalled();
  });

  it('requires interaction when current target policy exceeds family assurance', async () => {
    const enrolled = makePrisma({ twoFaEnabled: true });
    await expect(switchGuard(enrolled)(row)).rejects.toMatchObject({
      statusCode: 403,
      message: 'INTERACTION_REQUIRED',
    });
    expect(enrolled.$executeRaw).not.toHaveBeenCalled();

    const required = makePrisma({ targetPolicy: 'REQUIRED' });
    await expect(switchGuard(required)(row)).rejects.toMatchObject({
      statusCode: 403,
      message: 'INTERACTION_REQUIRED',
    });
    expect(required.$executeRaw).not.toHaveBeenCalled();
  });

  it('replay validates the exact returned target without depending on the old source', async () => {
    const prisma = makePrisma({ activeOrgs: [target.orgId], activeTeams: [target.teamId] });

    await expect(switchGuard(prisma, false)({ ...row, ...target })).resolves.toBeUndefined();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
  });
});
