import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAdminAuthDomain } from '../../src/config/env.js';
import { assertTenantEffectAuthority } from '../../src/services/tenant-effect-authority.service.js';
import { lockProductTeamPolicyExclusive } from '../../src/services/product-team-policy-lock.service.js';
import { lockRefreshSessionUser } from '../../src/services/refresh-session-lock.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { guardPoolCheckouts } from '../../src/db/pool-checkout-guard.js';
import { runWithOrgAdminEffectTransaction } from '../../src/plugins/tenant-context.plugin.js';

describe.skipIf(!process.env.DATABASE_URL)('tenant effect authority on PostgreSQL', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  beforeAll(async () => { const db = await createTestDb(); if (!db) throw new Error('DB required'); handle = db; });
  afterAll(async () => { await handle?.cleanup(); });
  beforeEach(async () => {
    await handle.prisma.$executeRawUnsafe('TRUNCATE users, organisations CASCADE');
  });
  async function fixture() {
    const actor = await handle.prisma.user.create({ data: { email: `${randomUUID()}@example.com`, userKey: randomUUID() } });
    await handle.prisma.domainRole.create({ data: { userId: actor.id, domain: getAdminAuthDomain(), role: 'SUPERUSER' } });
    const org = await handle.prisma.organisation.create({ data: { domain: 'effect.example.com',
      name: 'Before', slug: randomUUID(), ownerId: actor.id } });
    const request = { adminAccessTokenClaims: { userId: actor.id, tokenVersion: actor.tokenVersion,
      role: 'superuser', domain: getAdminAuthDomain() }, params: {}, body: {} } as unknown as FastifyRequest;
    const context = { domain: org.domain, orgId: org.id };
    const effect = () => handle.prisma.$transaction(async tx => {
      await assertTenantEffectAuthority(request, context, tx, handle.prisma);
      await tx.organisation.update({ where: { id: org.id }, data: { name: 'After' } });
    });
    return { actor, org, request, context, effect };
  }
  it('holds policy and actor revocation locks until the authorized effect commits', async () => {
    const f = await fixture();
    await handle.prisma.$transaction(async tx => {
      await assertTenantEffectAuthority(f.request, f.context, tx, handle.prisma);
      const lockAvailability = await handle.prisma.$transaction(async competing => {
        const policy = await competing.$queryRaw<Array<{ available: boolean }>>(Prisma.sql`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${'uoa:product-team-policy:v1'},0)) AS available`);
        const actor = await competing.$queryRaw<Array<{ available: boolean }>>(Prisma.sql`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${JSON.stringify(['uoa:refresh-session:user:v1', f.actor.id])},0)) AS available`);
        return [policy[0]?.available, actor[0]?.available];
      });
      expect(lockAvailability).toEqual([false, false]);
      await tx.organisation.update({ where: { id: f.org.id }, data: { name: 'After' } });
    });
    await handle.prisma.$transaction(async tx => {
      await lockRefreshSessionUser(f.actor.id, { prisma: tx });
      await tx.user.update({ where: { id: f.actor.id }, data: { tokenVersion: { increment: 1 } } });
    });
    expect((await handle.prisma.organisation.findUniqueOrThrow({ where: { id: f.org.id } })).name).toBe('After');
    await expect(f.effect()).rejects.toThrow('AUTHENTICATION_FAILED');
  });
  it('rejects disablement that committed after preauthentication but before the effect', async () => {
    const f = await fixture();
    await handle.prisma.$transaction(async tx => {
      await lockProductTeamPolicyExclusive(tx);
      await lockRefreshSessionUser(f.actor.id, { prisma: tx });
      await tx.user.update({ where: { id: f.actor.id }, data: { lifecycleStatus: 'DISABLED', tokenVersion: { increment: 1 } } });
    });
    await expect(f.effect()).rejects.toThrow('AUTHENTICATION_FAILED');
    expect((await handle.prisma.organisation.findUniqueOrThrow({ where: { id: f.org.id } })).name).toBe('Before');
  });
  it('uses the current admin transaction for authority without a nested pool checkout', async () => {
    const f = await fixture();
    f.request.adminDb = guardPoolCheckouts(handle.prisma, 'admin');
    f.request.tenantContext = f.context;
    await runWithOrgAdminEffectTransaction(f.request, async tx => {
      await tx.organisation.update({ where: { id: f.org.id }, data: { name: 'After' } });
      await tx.orgAuditLog.create({ data: { orgId: f.org.id, actorUserId: f.actor.id,
        action: 'org.updated', targetType: 'organisation', targetId: f.org.id } });
    });
    expect((await handle.prisma.organisation.findUniqueOrThrow({ where: { id: f.org.id } })).name).toBe('After');
    expect(await handle.prisma.orgAuditLog.count({ where: { targetId: f.org.id } })).toBe(1);
  });
  it('rejects a revoked platform role and a disabled target container at effect time', async () => {
    const f = await fixture();
    await handle.prisma.$transaction(async tx => {
      await lockProductTeamPolicyExclusive(tx);
      await tx.domainRole.deleteMany({ where: { userId: f.actor.id } });
    });
    await expect(f.effect()).rejects.toThrow('AUTHENTICATION_FAILED');
    await handle.prisma.domainRole.create({ data: { userId: f.actor.id, domain: getAdminAuthDomain(), role: 'SUPERUSER' } });
    await handle.prisma.organisation.update({ where: { id: f.org.id }, data: { lifecycleStatus: 'DISABLED' } });
    await expect(f.effect()).rejects.toThrow('ACCESS_DENIED');
  });
  it('forbids new inactive references to terminal users while allowing existing removals', async () => {
    const f = await fixture();
    const member = await handle.prisma.orgMember.create({ data: { orgId: f.org.id, userId: f.actor.id, role: 'owner' } });
    await handle.prisma.user.update({ where: { id: f.actor.id }, data: { lifecycleStatus: 'DELETING' } });
    await handle.prisma.orgMember.update({ where: { id: member.id }, data: { status: 'REMOVED' } });
    const sibling = await handle.prisma.user.create({ data: { email: `${randomUUID()}@example.com`, userKey: randomUUID() } });
    const org = await handle.prisma.organisation.create({ data: { domain: 'other.example.com', name: 'Other', slug: randomUUID(), ownerId: sibling.id } });
    await expect(handle.prisma.orgMember.create({ data: { orgId: org.id, userId: f.actor.id,
      role: 'member', status: 'REMOVED' } })).rejects.toThrow();
  });
});
