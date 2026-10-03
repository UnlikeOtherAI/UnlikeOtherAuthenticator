import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdminAuthDomain } from '../../config/env.js';
import { digestDomainClientHash } from '../../utils/client-hash.js';
import { assertTenantEffectAuthority } from '../tenant-effect-authority.service.js';

const context = { domain: 'product.example.com', orgId: 'org' };
const bearer = 'a'.repeat(64);
function fixture() {
  const events: string[] = [];
  const tx = { $queryRaw: vi.fn(async (query: Prisma.Sql) => {
    events.push(String(query.values[0])); return [];
  }) } as unknown as Prisma.TransactionClient;
  const db = {
    user: { findUnique: vi.fn(async () => {
      events.push('actor read'); return { lifecycleStatus: 'ACTIVE', tokenVersion: 4 };
    }) },
    domainRole: { findUnique: vi.fn(async () => ({ role: 'SUPERUSER' })) },
    organisation: { findUnique: vi.fn(async () => ({ lifecycleStatus: 'ACTIVE', domain: context.domain })) },
    team: { findUnique: vi.fn(async () => ({ lifecycleStatus: 'ACTIVE', orgId: 'org' })) },
    orgMember: { findUnique: vi.fn(async () => ({ status: 'ACTIVE' })) },
    teamMember: { findUnique: vi.fn(async () => ({ status: 'ACTIVE' })) },
    clientDomain: { findUnique: vi.fn(async () => ({ id: 'registered', status: 'active',
      secrets: [{ secretDigest: digestDomainClientHash(bearer), hashPrefix: bearer.slice(0, 12) }] })) },
  };
  const request = {
    accessTokenClaims: { userId: 'z-actor', tokenVersion: 4, domain: context.domain,
      role: 'user', email: 'actor@example.com', clientId: 'client',
      active: { orgId: 'org', teamId: 'selected' } },
    domainAuthClientId: bearer, domainAuthClientDomainId: 'registered',
    params: { teamId: 'target', userId: 'a-subject' }, body: { userId: 'a-subject' },
  } as unknown as FastifyRequest;
  const guard = () => assertTenantEffectAuthority(request, context, tx, db as unknown as PrismaClient);
  return { events, tx, db, request, guard };
}

describe('tenant transaction effect authority', () => {
  const originalUrl = process.env.DATABASE_URL;
  beforeEach(() => { process.env.DATABASE_URL = 'postgresql://unit.invalid/database'; });
  afterEach(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });
  it('locks policy then canonical actor/subject IDs in sorted order before reading authority', async () => {
    const f = fixture(); await f.guard();
    expect(f.events).toEqual(['uoa:product-team-policy:v1',
      JSON.stringify(['uoa:refresh-session:user:v1', 'a-subject']),
      JSON.stringify(['uoa:refresh-session:user:v1', 'z-actor']), 'actor read']);
    expect(f.db.team.findUnique.mock.calls).toHaveLength(2);
  });
  it.each(['DISABLED', 'DELETING', 'DELETED'])('rejects a %s actor despite earlier verified claims', async (status) => {
    const f = fixture(); f.db.user.findUnique.mockResolvedValue({ lifecycleStatus: status, tokenVersion: 4 });
    await expect(f.guard()).rejects.toThrow('AUTHENTICATION_FAILED');
  });
  it('rejects logout/credential revocation that won before the transaction', async () => {
    const f = fixture(); f.db.user.findUnique.mockResolvedValue({ lifecycleStatus: 'ACTIVE', tokenVersion: 5 });
    await expect(f.guard()).rejects.toThrow('AUTHENTICATION_FAILED');
  });
  it('does not interpret the tenant subject override as authenticated actor authority', async () => {
    const f = fixture(); f.request.accessTokenClaims = undefined;
    await expect(assertTenantEffectAuthority(f.request, { ...context, userId: 'forged' },
      f.tx, f.db as unknown as PrismaClient)).rejects.toThrow('AUTHENTICATION_FAILED');
  });
  it('rejects a revoked selected membership and a disabled exact target team', async () => {
    const f = fixture(); f.db.teamMember.findUnique.mockResolvedValue({ status: 'REMOVED' });
    await expect(f.guard()).rejects.toThrow('AUTHENTICATION_FAILED');
    f.db.teamMember.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    f.db.team.findUnique.mockResolvedValueOnce({ lifecycleStatus: 'ACTIVE', orgId: 'org' })
      .mockResolvedValueOnce({ lifecycleStatus: 'DISABLED', orgId: 'org' });
    await expect(f.guard()).rejects.toThrow('ACCESS_DENIED');
  });
  it('revalidates exact backend credential instead of accepting a stable domain ID alone', async () => {
    const f = fixture(); f.request.accessTokenClaims = undefined;
    f.request.orgBackendCaller = { domain: context.domain };
    f.db.clientDomain.findUnique.mockResolvedValue({ id: 'registered', status: 'disabled', secrets: [] });
    await expect(assertTenantEffectAuthority(f.request, { ...context, domainBackend: true },
      f.tx, f.db as unknown as PrismaClient)).rejects.toThrow('UNAUTHORIZED');
  });
  it('rechecks a platform admin role and does not bypass disabled containers', async () => {
    const f = fixture(); const claims = f.request.accessTokenClaims;
    if (!claims) throw new Error('fixture claims required');
    f.request.adminAccessTokenClaims = { ...claims, domain: getAdminAuthDomain(), role: 'superuser' };
    f.db.domainRole.findUnique.mockResolvedValue({ role: 'USER' });
    await expect(f.guard()).rejects.toThrow('AUTHENTICATION_FAILED');
    f.db.domainRole.findUnique.mockResolvedValue({ role: 'SUPERUSER' });
    f.db.organisation.findUnique.mockResolvedValue({ lifecycleStatus: 'DISABLED', domain: context.domain });
    await expect(f.guard()).rejects.toThrow('ACCESS_DENIED');
  });
  it('allows explicit domain-only route authority with live credential and same-origin target', async () => {
    const f = fixture(); f.request.accessTokenClaims = undefined;
    await expect(assertTenantEffectAuthority(f.request, context, f.tx,
      f.db as unknown as PrismaClient, { authority: 'domain' })).resolves.toBeUndefined();
    f.db.organisation.findUnique.mockResolvedValue({ lifecycleStatus: 'ACTIVE', domain: 'other.example.com' });
    await expect(assertTenantEffectAuthority(f.request, context, f.tx,
      f.db as unknown as PrismaClient, { authority: 'domain' })).rejects.toThrow('NOT_FOUND');
  });
});
