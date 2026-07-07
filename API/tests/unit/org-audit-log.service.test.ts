import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { writeOrgAuditLog } from '../../src/services/org-audit-log.service.js';

describe('writeOrgAuditLog', () => {
  it('writes a row with org, actor, action, target and metadata', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'oal-1' });
    const prisma = { orgAuditLog: { create } } as unknown as PrismaClient;

    await writeOrgAuditLog(
      {
        orgId: 'org-1',
        actorUserId: 'user-1',
        action: 'member.deactivated',
        targetType: 'org_member',
        targetId: 'member-1',
        metadata: { userId: 'user-2', role: 'admin' },
      },
      { prisma },
    );

    expect(create).toHaveBeenCalledWith({
      data: {
        orgId: 'org-1',
        actorUserId: 'user-1',
        action: 'member.deactivated',
        targetType: 'org_member',
        targetId: 'member-1',
        metadata: { userId: 'user-2', role: 'admin' },
      },
    });
  });

  it('defaults actorUserId to null (system write) and metadata to empty object', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'oal-2' });
    const prisma = { orgAuditLog: { create } } as unknown as PrismaClient;

    await writeOrgAuditLog(
      {
        orgId: 'org-1',
        action: 'invite.accepted',
        targetType: 'invite',
        targetId: 'inv-1',
      },
      { prisma },
    );

    expect(create).toHaveBeenCalledWith({
      data: {
        orgId: 'org-1',
        actorUserId: null,
        action: 'invite.accepted',
        targetType: 'invite',
        targetId: 'inv-1',
        metadata: {},
      },
    });
  });
});
