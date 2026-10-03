import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { deleteOrganisation } from '../../src/services/organisation.service.organisation.js';

describe('legacy organisation deletion', () => {
  it.each(['admin_superuser', 'domain_backend'] as const)('requires reviewed workflow for %s without database writes', async via => {
    const remove = vi.fn(), transaction = vi.fn(), audit = vi.fn();
    const prisma = { organisation: { delete: remove }, $transaction: transaction } as unknown as PrismaClient;
    await expect(deleteOrganisation({ orgId: 'org-1', actor: { via, userId: 'admin', email: 'admin@example.com' } }, { prisma, auditPrisma: { orgAuditLog: { create: audit } } as unknown as Pick<PrismaClient, 'orgAuditLog'> })).rejects.toMatchObject({ statusCode: 409, message: 'ENTITY_DELETION_WORKFLOW_REQUIRED' });
    expect(remove).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
  });
});
