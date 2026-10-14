import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { authorizeDirectoryRead, issueDirectoryCredential, rotateDirectoryCredential } from '../../src/services/directory-credential.service.js';

function fixture() {
  const expiry = new Date(Date.now() + 3_600_000);
  const credential = { id: 'credential', clientDomainId: 'domain', expiresAt: expiry, revokedAt: null as Date | null };
  const raw = {
    $queryRaw: vi.fn(async () => []),
    user: { findUnique: vi.fn(async () => ({ email: 'operator@example.com', tokenVersion: 2, lifecycleStatus: 'ACTIVE' })) },
    domainRole: { findUnique: vi.fn(async () => ({ role: 'SUPERUSER' })) },
    clientDomain: { findUnique: vi.fn(async () => ({ id: 'domain', status: 'active', domain: 'client.example.com' })) },
    directoryCredential: { create: vi.fn(async () => credential), findUnique: vi.fn(async () => credential) },
    directoryCredentialSecret: { findUnique: vi.fn(async () => ({ credentialId: 'credential', expiresAt: expiry, credential })),
      updateMany: vi.fn(async () => ({ count: 1 })), create: vi.fn(async () => ({})) },
    directoryOrganisationGrant: { findUnique: vi.fn(async () => ({ id: 'grant', revokedAt: null as Date | null, permissions: ['MEMBERSHIP_READ'] })) },
    adminAuditLog: { create: vi.fn(async () => ({})) },
  };
  return { raw, db: raw as unknown as PrismaClient, expiry, credential };
}
const authorization = 'Bearer uoa_dir_' + 'a'.repeat(43);
const read = { authorization, orgId: 'exact-org', permission: 'MEMBERSHIP_READ' as const };
const actor = { userId: 'operator', tokenVersion: 2 };
describe('purpose-bound directory authority', () => {
  it('issues a one-time purpose secret and stores only its purpose digest/prefix', async () => {
    const f = fixture();
    const result = await issueDirectoryCredential({ clientDomainId: 'domain', label: 'Product', expiresAt: f.expiry, actor }, f.db);
    expect(result.secret).toMatch(/^uoa_dir_[A-Za-z0-9_-]{43}$/);
    const stored = JSON.stringify(f.raw.directoryCredential.create.mock.calls);
    expect(stored).not.toContain(result.secret);
    expect(stored).toContain(result.secret.slice(0, 16));
    expect(stored).toMatch(/"digest":"[a-f0-9]{64}"/);
    expect(JSON.stringify(f.raw.adminAuditLog.create.mock.calls)).not.toContain(result.secret);
  });
  it('never treats a domain bearer or user token as a background credential', async () => {
    const f = fixture();
    for (const value of ['Bearer ' + 'a'.repeat(64), 'Bearer jwt.value.signature', undefined]) {
      await expect(authorizeDirectoryRead({ ...read, authorization: value }, f.db)).rejects.toMatchObject({ statusCode: 401 });
    }
    expect(f.raw.directoryCredentialSecret.findUnique).not.toHaveBeenCalled();
  });
  it('requires the exact org grant and exact requested permission, without an implicit domain grant', async () => {
    const f = fixture();
    expect(await authorizeDirectoryRead(read, f.db)).toMatchObject({ credentialId: 'credential', grantId: 'grant' });
    expect(f.raw.directoryOrganisationGrant.findUnique).toHaveBeenCalledWith({ where: { credentialId_orgId: { credentialId: 'credential', orgId: 'exact-org' } } });
    await expect(authorizeDirectoryRead({ ...read, permission: 'DISPLAY_READ' }, f.db)).rejects.toMatchObject({ statusCode: 403 });
    f.raw.directoryOrganisationGrant.findUnique.mockResolvedValue(null as never);
    await expect(authorizeDirectoryRead({ ...read, orgId: 'other-org' }, f.db)).rejects.toMatchObject({ statusCode: 403 });
  });
  it('re-reads revocation, grant and active product authority on every call', async () => {
    const f = fixture(); await authorizeDirectoryRead(read, f.db);
    f.credential.revokedAt = new Date();
    await expect(authorizeDirectoryRead(read, f.db)).rejects.toMatchObject({ statusCode: 401 });
    f.credential.revokedAt = null;
    f.raw.clientDomain.findUnique.mockResolvedValue({ id: 'domain', status: 'disabled', domain: 'client.example.com' });
    await expect(authorizeDirectoryRead(read, f.db)).rejects.toMatchObject({ statusCode: 401 });
    f.raw.clientDomain.findUnique.mockResolvedValue({ id: 'domain', status: 'active', domain: 'client.example.com' });
    f.raw.directoryOrganisationGrant.findUnique.mockResolvedValue({ id: 'grant', revokedAt: new Date(), permissions: ['MEMBERSHIP_READ'] });
    await expect(authorizeDirectoryRead(read, f.db)).rejects.toMatchObject({ statusCode: 403 });
  });
  it('propagates dependency outages instead of returning an authentication failure', async () => {
    const f = fixture(); const outage = new Error('database unavailable');
    f.raw.directoryCredentialSecret.findUnique.mockRejectedValue(outage);
    await expect(authorizeDirectoryRead(read, f.db)).rejects.toBe(outage);
  });
  it('bounds rotation overlap without silently changing grants', async () => {
    const f = fixture();
    const result = await rotateDirectoryCredential({ credentialId: 'credential', overlapSeconds: 600, actor }, f.db);
    const end = new Date(result.previous_secrets_expire_at).getTime();
    expect(end).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(f.raw.directoryCredentialSecret.create).toHaveBeenCalled();
    expect(f.raw.directoryOrganisationGrant.findUnique).not.toHaveBeenCalled();
    await expect(rotateDirectoryCredential({ credentialId: 'credential', overlapSeconds: 601, actor }, f.db)).rejects.toMatchObject({ statusCode: 400 });
  });
});
