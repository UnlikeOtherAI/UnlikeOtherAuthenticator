import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDirectoryGrant } from '../../src/services/directory-grant.service.js';
import type { ProfileAuthority } from '../../src/services/profile.service.js';
import { digestDomainClientHash } from '../../src/utils/client-hash.js';

const originalDatabase = process.env.DATABASE_URL;
beforeEach(() => { process.env.DATABASE_URL = 'postgresql://owner-grant.unit.invalid/db'; });
afterEach(() => { if (originalDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabase; });

function fixture() {
  const authority = { claims: { userId: 'owner', tokenVersion: 2, domain: 'product.example.com',
    org: { org_id: 'org' } }, expiresAt: Date.now() / 1000 + 60,
    config: { domain: 'product.example.com' }, clientDomainId: 'domain', domainCredential: 'a'.repeat(64),
  } as ProfileAuthority;
  const account = { tokenVersion: 2, lifecycleStatus: 'ACTIVE' };
  const org = { ownerId: 'owner', lifecycleStatus: 'ACTIVE' };
  const member = { role: 'owner', status: 'ACTIVE' };
  const credential = { clientDomainId: 'domain', expiresAt: new Date(Date.now() + 60_000), revokedAt: null as Date | null };
  const domain = { id: 'domain', domain: 'product.example.com', status: 'active', secrets: [
    { secretDigest: digestDomainClientHash(authority.domainCredential), hashPrefix: 'synthetic' },
  ] };
  const raw = {
    $queryRaw: vi.fn(async () => []), user: { findUnique: vi.fn(async () => account) },
    domainRole: { findUnique: vi.fn(async () => ({ userId: 'owner' })) },
    clientDomain: { findUnique: vi.fn(async () => domain) },
    organisation: { findUnique: vi.fn(async () => org) },
    orgMember: { findUnique: vi.fn(async () => member) },
    directoryCredential: { findUnique: vi.fn(async () => credential) },
    directoryOrganisationGrant: { upsert: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })) },
    orgAuditLog: { create: vi.fn(async () => ({})) },
  };
  return { raw, db: raw as unknown as PrismaClient, authority, org, member, account, credential, domain };
}
const grant = { orgId: 'org', credentialId: 'credential', permissions: ['MEMBERSHIP_READ' as const] };

describe('exact owner directory permission grants', () => {
  it('stores only the exact org permission and actor reference with its audit', async () => {
    const f = fixture();
    await expect(setDirectoryGrant(f.authority, grant, f.db)).resolves.toEqual({ ok: true });
    expect(f.raw.directoryOrganisationGrant.upsert).toHaveBeenCalledWith({
      where: { credentialId_orgId: { credentialId: 'credential', orgId: 'org' } },
      create: { credentialId: 'credential', orgId: 'org', permissions: ['MEMBERSHIP_READ'], grantedByUserId: 'owner' },
      update: { permissions: ['MEMBERSHIP_READ'], grantedByUserId: 'owner', revokedAt: null },
    });
    expect(f.raw.orgAuditLog.create).toHaveBeenCalledOnce();
  });

  it.each(['other-claimed-org', 'other-current-owner', 'non-owner-role', 'suspended', 'removed', 'disabled-org'])('refuses %s using current authority', async (state) => {
    const f = fixture();
    if (state === 'other-claimed-org') f.authority.claims.org!.org_id = 'other';
    if (state === 'other-current-owner') f.org.ownerId = 'another-owner';
    if (state === 'non-owner-role') f.member.role = 'admin';
    if (state === 'suspended') f.member.status = 'DEACTIVATED';
    if (state === 'removed') f.member.status = 'REMOVED';
    if (state === 'disabled-org') f.org.lifecycleStatus = 'DISABLED';
    await expect(setDirectoryGrant(f.authority, grant, f.db)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.raw.directoryOrganisationGrant.upsert).not.toHaveBeenCalled();
    expect(f.raw.orgAuditLog.create).not.toHaveBeenCalled();
  });

  it.each(['stale-epoch', 'expired-actor', 'disabled-actor'])('refuses %s before grant mutation', async (state) => {
    const f = fixture();
    if (state === 'stale-epoch') f.account.tokenVersion++;
    if (state === 'expired-actor') f.authority.expiresAt = Date.now() / 1000 - 1;
    if (state === 'disabled-actor') f.account.lifecycleStatus = 'DISABLED';
    await expect(setDirectoryGrant(f.authority, grant, f.db)).rejects.toMatchObject({ statusCode: 401 });
    expect(f.raw.directoryOrganisationGrant.upsert).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'expired'])('cannot grant a %s credential', async (state) => {
    const f = fixture();
    if (state === 'revoked') f.credential.revokedAt = new Date();
    else f.credential.expiresAt = new Date(Date.now() - 1);
    await expect(setDirectoryGrant(f.authority, grant, f.db)).rejects.toMatchObject({ statusCode: 404 });
    expect(f.raw.directoryOrganisationGrant.upsert).not.toHaveBeenCalled();
  });

  it('permits idempotent revocation of a no-longer-present credential grant', async () => {
    const f = fixture(); f.raw.directoryCredential.findUnique.mockResolvedValue(null as never);
    await expect(setDirectoryGrant(f.authority, { ...grant, revoke: true }, f.db)).resolves.toEqual({ ok: true });
    expect(f.raw.directoryOrganisationGrant.updateMany).toHaveBeenCalledWith({
      where: { orgId: 'org', credentialId: 'credential', revokedAt: null }, data: { revokedAt: expect.any(Date) },
    });
    expect(f.raw.directoryOrganisationGrant.upsert).not.toHaveBeenCalled();
  });
});
