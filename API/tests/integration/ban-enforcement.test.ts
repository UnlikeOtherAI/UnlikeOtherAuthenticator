import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { createTestDb } from '../helpers/test-db.js';
import {
  createAdminBan,
  deleteAdminBan,
  listAdminBans,
} from '../../src/services/internal-admin-bans.service.js';
import {
  assertNotBannedAtLogin,
  isPrincipalBannedForRegistration,
} from '../../src/services/ban-policy.service.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)('ban enforcement (db)', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  let prisma: PrismaClient;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('expected a test database');
    prisma = handle.prisma;
  });

  afterAll(async () => {
    await handle?.cleanup();
  });

  it('blocks a banned email at login and registration, then lifts on delete', async () => {
    const domain = 'ban-it.example.com';
    const banned = await prisma.user.create({
      data: { email: 'mallory@evil.com', userKey: `${domain}|mallory@evil.com`, domain },
      select: { id: true },
    });

    const created = await createAdminBan(
      { type: 'EMAIL', value: 'Mallory@Evil.com', domain, reason: 'abuse', createdByEmail: 'admin@uoa' },
      { prisma },
    );
    expect(created.value).toBe('mallory@evil.com'); // normalized to lower-case
    expect(created.label).toBe(domain); // client-domain scope

    const bans = await listAdminBans({ prisma });
    expect(bans.emails.some((b) => b.id === created.id && b.reason === 'abuse')).toBe(true);

    await expect(assertNotBannedAtLogin({ userId: banned.id, domain }, { prisma })).rejects.toMatchObject({
      statusCode: 403,
      message: 'ACCESS_DENIED',
    });
    await expect(
      isPrincipalBannedForRegistration({ domain, email: 'mallory@evil.com' }, { prisma }),
    ).resolves.toBe(true);

    // A different principal on the same domain is unaffected.
    const ok = await prisma.user.create({
      data: { email: 'good@example.com', userKey: `${domain}|good@example.com`, domain },
      select: { id: true },
    });
    await expect(assertNotBannedAtLogin({ userId: ok.id, domain }, { prisma })).resolves.toBeUndefined();
    await expect(
      isPrincipalBannedForRegistration({ domain, email: 'good@example.com' }, { prisma }),
    ).resolves.toBe(false);

    await deleteAdminBan(created.id, { prisma });
    await expect(assertNotBannedAtLogin({ userId: banned.id, domain }, { prisma })).resolves.toBeUndefined();
  });

  it('enforces an organisation-scope ban only on that org and rejects cross-tenant scope', async () => {
    const domain = 'org-ban.example.com';
    const owner = await prisma.user.create({
      data: { email: 'owner@org-ban.example.com', userKey: `${domain}|owner`, domain },
      select: { id: true },
    });
    const member = await prisma.user.create({
      data: { email: 'member@org-ban.example.com', userKey: `${domain}|member`, domain },
      select: { id: true },
    });
    const org = await prisma.organisation.create({
      data: { domain, name: 'Acme', slug: 'acme', ownerId: owner.id },
      select: { id: true },
    });
    await prisma.orgMember.create({ data: { orgId: org.id, userId: member.id, role: 'member' } });

    const created = await createAdminBan(
      { type: 'USER', value: member.id, domain, orgId: org.id },
      { prisma },
    );
    expect(created.label).toBe(`${domain} · org Acme`);

    // The org member is blocked; the owner (also on the domain but not banned) is not.
    await expect(assertNotBannedAtLogin({ userId: member.id, domain }, { prisma })).rejects.toMatchObject({
      message: 'ACCESS_DENIED',
    });
    await expect(assertNotBannedAtLogin({ userId: owner.id, domain }, { prisma })).resolves.toBeUndefined();

    // A ban whose org does not belong to the named domain is rejected.
    await expect(
      createAdminBan({ type: 'USER', value: 'x', domain: 'someone-else.example.com', orgId: org.id }, { prisma }),
    ).rejects.toMatchObject({ message: 'BAN_SCOPE_INVALID' });
  });
});
