import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { readDirectoryStanding, readDirectoryDisplay } from '../../src/services/directory-read.service.js';

function fixture() {
  const credential = { id: 'credential', clientDomainId: 'domain', expiresAt: new Date(Date.now() + 60_000), revokedAt: null };
  const membership = { status: 'ACTIVE', role: 'member', org: { lifecycleStatus: 'ACTIVE' },
    user: { id: 'subject', name: 'Current name', lifecycleStatus: 'ACTIVE', tokenVersion: 4 } };
  const raw = {
    $queryRaw: vi.fn(async () => []),
    directoryCredentialSecret: { findUnique: vi.fn(async () => ({ credentialId: 'credential', expiresAt: credential.expiresAt, credential })) },
    clientDomain: { findUnique: vi.fn(async () => ({ status: 'active' })) },
    directoryOrganisationGrant: { findUnique: vi.fn(async () => ({ id: 'grant', revokedAt: null,
      permissions: ['MEMBERSHIP_READ', 'DISPLAY_READ'] })) },
    orgMember: { findUnique: vi.fn(async () => membership) },
    organisation: { findUnique: vi.fn(async () => ({ lifecycleStatus: 'ACTIVE' })) },
    teamMember: { findMany: vi.fn(async () => [{ teamId: 'team', teamRole: 'member' }]) },
    historicalOrganisationIdentityReference: { findUnique: vi.fn(async () => null) },
  };
  return { raw, db: raw as unknown as PrismaClient, membership, credential };
}
const input = { authorization: 'Bearer uoa_dir_' + 'a'.repeat(43), orgId: 'exact-org', userId: 'subject' };

describe('live purpose-bound directory standing', () => {
  it('returns only exact current standing, epoch and team roles', async () => {
    const f = fixture();
    expect(await readDirectoryStanding(input, f.db)).toEqual({ subject: 'subject', organisation_id: 'exact-org',
      active: true, credential_epoch: 4, org_role: 'member', teams: [{ id: 'team', role: 'member' }] });
    expect(f.raw.teamMember.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'subject', status: 'ACTIVE', team: { orgId: 'exact-org', lifecycleStatus: 'ACTIVE' } }, take: 201,
    }));
    expect(f.raw.directoryCredentialSecret.findUnique).toHaveBeenCalledTimes(2);
  });

  it.each(['missing', 'suspended', 'removed', 'disabled-user', 'deleted-user', 'disabled-org'])('returns minimal inactive standing for %s', async (state) => {
    const f = fixture();
    if (state === 'missing') f.raw.orgMember.findUnique.mockResolvedValue(null as never);
    if (state === 'suspended') f.membership.status = 'DEACTIVATED';
    if (state === 'removed') f.membership.status = 'REMOVED';
    if (state === 'disabled-user') f.membership.user.lifecycleStatus = 'DISABLED';
    if (state === 'deleted-user') f.membership.user.lifecycleStatus = 'DELETED';
    if (state === 'disabled-org') f.membership.org.lifecycleStatus = 'DISABLED';
    expect(await readDirectoryStanding(input, f.db)).toEqual({ subject: 'subject', organisation_id: 'exact-org', active: false });
    expect(f.raw.teamMember.findMany).not.toHaveBeenCalled();
  });

  it('refuses an incomplete oversized team result', async () => {
    const f = fixture();
    f.raw.teamMember.findMany.mockResolvedValue(Array.from({ length: 201 }, (_, i) => ({ teamId: `team-${i}`, teamRole: 'member' })));
    await expect(readDirectoryStanding(input, f.db)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('rechecks credential expiry after waiting for the subject lock', async () => {
    const f = fixture(); let calls = 0;
    f.raw.directoryCredentialSecret.findUnique.mockImplementation(async () => {
      if (++calls === 2) f.credential.expiresAt = new Date(Date.now() - 1);
      return { credentialId: 'credential', expiresAt: f.credential.expiresAt, credential: f.credential };
    });
    await expect(readDirectoryStanding(input, f.db)).rejects.toMatchObject({ statusCode: 401 });
    expect(f.raw.orgMember.findUnique).not.toHaveBeenCalled();
  });

  it('propagates a standing dependency outage without calling the subject inactive', async () => {
    const f = fixture(); const outage = new Error('database unavailable');
    f.raw.orgMember.findUnique.mockRejectedValue(outage);
    await expect(readDirectoryStanding(input, f.db)).rejects.toBe(outage);
  });

  it('does not let membership-only permission read profile display', async () => {
    const f = fixture();
    f.raw.directoryOrganisationGrant.findUnique.mockResolvedValue({ id: 'grant', revokedAt: null, permissions: ['MEMBERSHIP_READ'] });
    await expect(readDirectoryDisplay(input, f.db)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.raw.orgMember.findUnique).not.toHaveBeenCalled();
  });

  it('uses the shared neutral former-member display policy', async () => {
    const f = fixture(); f.membership.status = 'REMOVED';
    expect(await readDirectoryDisplay(input, f.db)).toEqual({ id: 'subject', deleted: false, name: 'Former member' });
  });
});
