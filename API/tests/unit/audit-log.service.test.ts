import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '../../src/services/audit-log.service.js';

describe('writeAuditLog', () => {
  it('writes a row with actor, action, target and metadata', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'log-1' });
    const prisma = { adminAuditLog: { create } } as unknown as PrismaClient;

    await writeAuditLog(
      {
        actorEmail: 'admin@example.com',
        action: 'integration.declined',
        targetDomain: 'client.example.com',
        metadata: { integrationRequestId: 'req-1', reason: 'spam' },
      },
      { prisma },
    );

    expect(create).toHaveBeenCalledWith({
      data: {
        actorEmail: 'admin@example.com',
        action: 'integration.declined',
        targetDomain: 'client.example.com',
        metadata: { integrationRequestId: 'req-1', reason: 'spam' },
      },
    });
  });

  it('defaults metadata to empty object and targetDomain to null', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'log-1' });
    const prisma = { adminAuditLog: { create } } as unknown as PrismaClient;

    await writeAuditLog({ actorEmail: 'admin@example.com', action: 'jwk.added' }, { prisma });

    expect(create).toHaveBeenCalledWith({
      data: {
        actorEmail: 'admin@example.com',
        action: 'jwk.added',
        targetDomain: null,
        metadata: {},
      },
    });
  });
});
