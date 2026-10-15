import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { readOrUpdateSelfProfile, readOrganisationDisplay, ProfilePatch, type ProfileAuthority } from '../../src/services/profile.service.js';
import { readTargetDisplay } from '../../src/services/profile-display.service.js';
import { digestDomainClientHash } from '../../src/utils/client-hash.js';
const saved = process.env.DATABASE_URL;
beforeEach(() => { process.env.DATABASE_URL = 'postgresql://unit.invalid/profile'; });
afterEach(() => { if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved; });
function fixture() {
  const user: Record<string, unknown> = { id: 'person', email: 'self@example.com', name: 'Self', pronounsPreset: null,
    pronounsCustom: null, twoFaEnabled: false, tokenVersion: 3, lifecycleStatus: 'ACTIVE', createdAt: new Date('2026-01-01T00:00:00Z') };
  const authority = { claims: { userId: 'person', tokenVersion: 3, domain: 'client.example.com', email: 'self@example.com',
    clientId: 'domain', role: 'user', org: { org_id: 'org', org_role: 'owner', teams: [], team_roles: {} } },
    config: { domain: 'client.example.com' }, expiresAt: Date.now() / 1000 + 60,
    clientDomainId: 'domain', domainCredential: 'a'.repeat(64) } as ProfileAuthority;
  const raw = {
    $queryRaw: vi.fn(async () => []),
    clientDomain: { findUnique: vi.fn(async () => ({ id: 'domain', domain: authority.config.domain, status: 'active',
      secrets: [{ secretDigest: digestDomainClientHash(authority.domainCredential), hashPrefix: 'synthetic' }] })) },
    domainRole: { findUnique: vi.fn(async () => ({ userId: 'person' })) },
    user: { findUnique: vi.fn(async () => ({ ...user })), update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(user, data); return { ...user }; }) },
    organisation: { findUnique: vi.fn(async () => ({ lifecycleStatus: 'ACTIVE' })), findMany: vi.fn(async () => [{ id: 'org' }]) },
    orgMember: { findMany: vi.fn(async () => [{ orgId: 'org' }]), findUnique: vi.fn(async () => ({ status: 'ACTIVE', user: { id: 'target', name: 'Current name', lifecycleStatus: 'ACTIVE' } })) },
    historicalOrganisationIdentityReference: { findUnique: vi.fn(async () => null) },
  };
  return { raw, db: raw as unknown as PrismaClient, user, authority };
}
describe('canonical self profile authority', () => {
  it('reads current own email and derives pronouns without exposing authentication secrets', async () => {
    const f = fixture(); f.user.pronounsPreset = 'they_them';
    const result = await readOrUpdateSelfProfile(f.authority, f.db);
    expect(result).toMatchObject({ id: 'person', email: 'self@example.com', pronouns_display: 'they/them' });
    expect(Object.keys(result)).not.toContain('tokenVersion');
    expect(Object.keys(result)).not.toContain('passwordHash');
  });
  it('writes only provided name/pronouns and clears custom text when a preset changes', async () => {
    const f = fixture();
    await readOrUpdateSelfProfile(f.authority, f.db, { pronouns_preset: 'custom', pronouns_custom: 'xe/xem' });
    expect(f.user.pronounsCustom).toBe('xe/xem');
    const result = await readOrUpdateSelfProfile(f.authority, f.db, { name: ' New name ', pronouns_preset: 'he_him' });
    expect(result).toMatchObject({ name: 'New name', pronouns_display: 'he/him', pronouns_custom: null });
    expect(f.user.email).toBe('self@example.com');
    expect(JSON.stringify(f.raw.$queryRaw.mock.calls)).toContain('profile.changed');
  });
  it.each([{ email: 'other@example.com' }, { role: 'owner' }, { name: '  ' }, {}, { password: 'invalid' }])('rejects unsupported or invalid patch %j', patch => {
    expect(ProfilePatch.safeParse(patch).success).toBe(false);
  });
  it('rejects custom pronouns without text before any write', async () => {
    const f = fixture();
    await expect(readOrUpdateSelfProfile(f.authority, f.db, { pronouns_preset: 'custom' })).rejects.toMatchObject({ statusCode: 400 });
    expect(f.raw.user.update).not.toHaveBeenCalled();
  });
  it.each(['DISABLED', 'DELETING', 'DELETED'])('rejects a %s identity without a profile read/write result', async status => {
    const f = fixture(); f.user.lifecycleStatus = status;
    await expect(readOrUpdateSelfProfile(f.authority, f.db, { name: 'No' })).rejects.toMatchObject({ statusCode: 401 });
    expect(f.raw.user.update).not.toHaveBeenCalled();
  });
  it('rechecks expiry after a lock wait instead of applying an expired profile capability', async () => {
    const f = fixture(); f.raw.$queryRaw.mockImplementation(async () => { f.authority.expiresAt = Date.now() / 1000 - 1; return []; });
    await expect(readOrUpdateSelfProfile(f.authority, f.db, { name: 'No' })).rejects.toMatchObject({ statusCode: 401 });
    expect(f.raw.user.update).not.toHaveBeenCalled();
  });
  it('refuses a stale credential epoch and cross-domain person', async () => {
    const f = fixture(); f.user.tokenVersion = 4;
    await expect(readOrUpdateSelfProfile(f.authority, f.db)).rejects.toMatchObject({ statusCode: 401 });
    f.authority.claims.domain = 'another.example.com';
    await expect(readOrUpdateSelfProfile(f.authority, f.db)).rejects.toMatchObject({ statusCode: 401 });
  });
});
describe('exact historical display', () => {
  it('requires actor current scope and ACTIVE membership in the exact org', async () => {
    const f = fixture();
    await expect(readOrganisationDisplay(f.authority, { orgId: 'another', userId: 'target' }, f.db)).rejects.toMatchObject({ statusCode: 404 });
    f.raw.orgMember.findUnique.mockResolvedValue({ status: 'REMOVED', user: { id: 'person', name: 'Self', lifecycleStatus: 'ACTIVE' } });
    await expect(readOrganisationDisplay(f.authority, { orgId: 'org', userId: 'target' }, f.db)).rejects.toMatchObject({ statusCode: 404 });
  });
  it('shares a neutral former-member policy between interactive and background callers', async () => {
    const f = fixture(); f.raw.orgMember.findUnique.mockResolvedValue({ status: 'REMOVED', user: { id: 'target', name: 'Old private name', lifecycleStatus: 'ACTIVE' } });
    const result = await readTargetDisplay(f.db, { orgId: 'org', userId: 'target' });
    expect(result).toEqual({ id: 'target', name: 'Former member', deleted: false });
    expect(JSON.stringify(result)).not.toContain('Old private name');
  });
  it('does not treat a domain-wide historical association as exact-org permission', async () => {
    const f = fixture(); f.raw.orgMember.findUnique.mockResolvedValue(null as never);
    await expect(readTargetDisplay(f.db, { orgId: 'org', userId: 'deleted-target' })).rejects.toMatchObject({ statusCode: 404 });
    f.raw.historicalOrganisationIdentityReference.findUnique.mockResolvedValue({ user: { lifecycleStatus: 'DELETED' } } as never);
    expect(await readTargetDisplay(f.db, { orgId: 'org', userId: 'deleted-target' })).toEqual({ id: 'deleted-target', deleted: true, name: 'Deleted user' });
  });
});
