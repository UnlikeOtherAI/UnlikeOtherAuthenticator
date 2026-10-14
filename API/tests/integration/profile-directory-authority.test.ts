import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import { createProfileDirectoryFixture, profileDirectoryDomain as domain, profileDirectoryQuery as query } from '../helpers/profile-directory-fixture.js';
import { runWithTenantContext } from '../../src/db/tenant-context.js';
import { withDirectoryMutation } from '../../src/services/directory-mutation.service.js';
import { uploadAvatar } from '../../src/services/avatar.service.js';

describe.skipIf(!process.env.DATABASE_URL)('profile and directory real HTTP/PostgreSQL authority', () => {
  let suite: Awaited<ReturnType<typeof createProfileDirectoryFixture>>;
  let retain = false;
  beforeAll(async () => { suite = await createProfileDirectoryFixture(); });
  afterEach(({ task }) => { if (task.result?.state === 'fail') retain = true; });
  afterAll(async () => { await suite?.close(retain); });

  it('uses real uoa_app login with tenant RLS and machine-only outbox protection', async () => {
    const f = await suite.subject(), sibling = await suite.subject();
    const role = await suite.appDb.$queryRaw<Array<{ role: string; bypass: boolean }>>`
      SELECT current_user AS role, rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user`;
    expect(role).toEqual([{ role: 'uoa_app', bypass: false }]);
    const context = { domain, userId: f.owner.id, orgId: f.org.id };
    await runWithTenantContext({ context, prisma: suite.appDb }, async tx => {
      expect(await tx.orgMember.findMany({ where: { orgId: sibling.org.id } })).toEqual([]);
      await withDirectoryMutation(tx as unknown as PrismaClient,
        [{ orgId: f.org.id, kind: 'profile.changed', subjectId: f.owner.id }], async () => undefined);
      expect(await tx.directoryChangeOutbox.findMany()).toEqual([]);
    });
    await expect(runWithTenantContext({ context, prisma: suite.appDb }, async tx => {
      await withDirectoryMutation(tx as unknown as PrismaClient,
        [{ orgId: sibling.org.id, kind: 'profile.changed', subjectId: f.owner.id }], async () => {
          await tx.user.update({ where: { id: f.owner.id }, data: { name: 'Must roll back' } });
        });
    })).rejects.toThrow();
    expect((await suite.db.user.findUniqueOrThrow({ where: { id: f.owner.id } })).name).toBe('Canonical Owner');
    expect(await suite.db.directoryChangeOutbox.count({ where: { orgId: sibling.org.id } })).toBe(0);
  });

  it('reads/patches canonical self through signed config/domain/JWT and commits exact invalidations', async () => {
    const f = await suite.subject();
    const read = await suite.app.inject({ url: '/profile/me' + query, headers: f.headers });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ id: f.owner.id, email: f.owner.email, name: 'Canonical Owner' });
    expect(read.body).not.toContain('old-profile@example.com');
    const updated = await suite.app.inject({ method: 'PATCH', url: '/profile/me' + query, headers: f.headers,
      payload: { name: ' Updated canonical ', pronouns_preset: 'custom', pronouns_custom: 'xe/xem' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.headers['cache-control']).toBe('private, no-store');
    expect(updated.json()).toMatchObject({ name: 'Updated canonical', pronouns_display: 'xe/xem', email: f.owner.email });
    expect(await suite.db.directoryChangeOutbox.findMany({ where: { orgId: f.org.id }, select: { kind: true, subjectId: true, revision: true } }))
      .toEqual([{ kind: 'profile.changed', subjectId: f.owner.id, revision: 1n }]);
    const refused = await suite.app.inject({ method: 'PATCH', url: '/profile/me' + query, headers: f.headers, payload: { email: 'other@example.com' } });
    expect(refused.statusCode).toBe(400);
    expect(await suite.db.directoryChangeOutbox.count({ where: { orgId: f.org.id } })).toBe(1);
  });

  it('refuses missing/conflicting person credentials and stale live epoch without modifying a profile', async () => {
    const f = await suite.subject();
    const missing = await suite.app.inject({ url: '/profile/me' + query, headers: { authorization: f.headers.authorization } });
    expect(missing.statusCode).toBe(401);
    const conflict = await suite.app.inject({ url: '/profile/me' + query,
      headers: { ...f.headers, 'x-uoa-subject-assertion': f.headers['x-uoa-access-token'] } });
    expect(conflict.statusCode).toBe(401);
    await suite.db.user.update({ where: { id: f.owner.id }, data: { tokenVersion: { increment: 1 } } });
    const stale = await suite.app.inject({ method: 'PATCH', url: '/profile/me' + query, headers: f.headers, payload: { name: 'No' } });
    expect(stale.statusCode).toBe(401);
    expect(stale.headers['cache-control']).toBe('private, no-store');
    expect(await suite.db.directoryChangeOutbox.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  it('refuses an expired profile capability after an observed PostgreSQL lock wait', async () => {
    const f = await suite.subject();
    const blocker = await suite.holdUser(f.owner.id);
    const token = await f.token('2s');
    const pending = suite.app.inject({ method: 'PATCH', url: '/profile/me' + query,
      headers: { ...f.headers, 'x-uoa-access-token': token }, payload: { name: 'Expired write' } }).then(value => value);
    try {
      await suite.waitForBlocked(blocker.pid);
      const wait = decodeJwt(token).exp! * 1000 - Date.now() + 50;
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    } finally { await blocker.release(); }
    expect((await pending).statusCode).toBe(401);
    expect((await suite.db.user.findUniqueOrThrow({ where: { id: f.owner.id } })).name).toBe('Canonical Owner');
    expect(await suite.db.directoryChangeOutbox.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  it('preserves nullable active display, exact retained history and neutral removed/erased references', async () => {
    const f = await suite.subject();
    const path = `/org/organisations/${f.org.id}/users/${f.target.id}/display`;
    await suite.db.user.update({ where: { id: f.target.id }, data: { name: null } });
    const active = await suite.app.inject({ url: path + query, headers: f.headers });
    expect(active.statusCode).toBe(200);
    expect(active.json()).toMatchObject({ id: f.target.id, name: null, deleted: false });
    expect(active.body).not.toContain(f.target.email!);
    await suite.db.orgMember.update({ where: { orgId_userId: { orgId: f.org.id, userId: f.target.id } }, data: { status: 'REMOVED' } });
    const removed = await suite.app.inject({ url: path + query, headers: f.headers });
    expect(removed.json()).toEqual({ id: f.target.id, name: 'Former member', deleted: false });
    expect((await suite.app.inject({ url: path + '/avatar' + query, headers: f.headers })).statusCode).toBe(404);
    await suite.db.orgMember.delete({ where: { orgId_userId: { orgId: f.org.id, userId: f.target.id } } });
    await suite.db.user.update({ where: { id: f.target.id }, data: { lifecycleStatus: 'DELETED', email: null, userKey: null, name: null } });
    expect((await suite.app.inject({ url: path + query, headers: f.headers })).statusCode).toBe(404);
    await suite.db.historicalOrganisationIdentityReference.create({ data: { userId: f.target.id, orgId: f.org.id } });
    expect((await suite.app.inject({ url: path + query, headers: f.headers })).json()).toEqual({ id: f.target.id, name: 'Deleted user', deleted: true });
    await suite.db.user.delete({ where: { id: f.target.id } });
    expect((await suite.app.inject({ url: path + query, headers: f.headers })).statusCode).toBe(404);
  });

  it('returns actual uploaded avatar bytes through authenticated no-store HTTP', async () => {
    const f = await suite.subject();
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0x21)]);
    await uploadAvatar({ userId: f.owner.id, data: bytes }, { prisma: suite.db });
    const response = await suite.app.inject({ url: '/profile/me/avatar' + query, headers: f.headers });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(bytes)).toBe(true);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect((await suite.app.inject({ url: '/profile/me/avatar' + query, headers: { authorization: f.headers.authorization } })).statusCode).toBe(401);
    expect(await suite.db.directoryChangeOutbox.count({ where: { orgId: f.org.id, kind: 'profile.changed' } })).toBe(1);
  });

  it('provisions through the documented operator/owner HTTP doorway and separates permissions', async () => {
    const f = await suite.subject();
    const credential = await suite.directory(f, ['MEMBERSHIP_READ']);
    const path = `/directory/v1/organisations/${f.org.id}/subjects/${f.owner.id}`;
    const standing = await suite.app.inject({ url: path + '/standing', headers: credential.headers });
    expect(standing.statusCode).toBe(200);
    expect(standing.json()).toEqual({ subject: f.owner.id, organisation_id: f.org.id, active: true,
      credential_epoch: 0, org_role: 'owner', teams: [{ id: f.team.id, role: 'owner' }] });
    expect((await suite.app.inject({ url: path + '/display', headers: credential.headers })).statusCode).toBe(403);
    expect((await suite.app.inject({ url: path + '/standing', headers: f.headers })).statusCode).toBe(401);
    const other = await suite.subject();
    expect((await suite.app.inject({ url: `/directory/v1/organisations/${other.org.id}/subjects/${other.owner.id}/standing`, headers: credential.headers })).statusCode).toBe(403);
    const inactive = await suite.app.inject({ url: `/directory/v1/organisations/${f.org.id}/subjects/${other.owner.id}/standing`, headers: credential.headers });
    expect(inactive.json()).toEqual({ subject: other.owner.id, organisation_id: f.org.id, active: false });
  });

  it('denies a former owner from granting access using stale owner claims', async () => {
    const f = await suite.subject();
    const credential = await suite.directory(f);
    await suite.db.orgMember.update({ where: { orgId_userId: { orgId: f.org.id, userId: f.owner.id } }, data: { role: 'admin' } });
    const response = await suite.app.inject({ method: 'PUT', url: `/org/organisations/${f.org.id}/product-access/${credential.id}${query}`,
      headers: f.headers, payload: { permissions: ['MEMBERSHIP_READ'] } });
    expect(response.statusCode).toBe(403);
  });

  it('rechecks real directory credential expiry after a PostgreSQL subject-lock wait', async () => {
    const f = await suite.subject(), credential = await suite.directory(f);
    const expiresAt = new Date(Date.now() + 2000);
    await suite.db.directoryCredentialSecret.updateMany({ where: { credentialId: credential.id }, data: { expiresAt } });
    const blocker = await suite.holdUser(f.owner.id);
    const pending = suite.app.inject({ url: `/directory/v1/organisations/${f.org.id}/subjects/${f.owner.id}/standing`, headers: credential.headers }).then(value => value);
    try {
      await suite.waitForBlocked(blocker.pid);
      const wait = expiresAt.getTime() - Date.now() + 50;
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    } finally { await blocker.release(); }
    const refused = await pending;
    expect(refused.statusCode).toBe(401);
    expect(refused.headers['cache-control']).toBe('private, no-store');
  });

  it('holds directory read authority through commit and serializes current credential revocation', async () => {
    const f = await suite.subject(), credential = await suite.directory(f);
    const path = `/directory/v1/organisations/${f.org.id}/subjects/${f.owner.id}/standing`;
    const blocker = await suite.holdUser(f.owner.id);
    const read = suite.app.inject({ url: path, headers: credential.headers }).then(value => value);
    let revoked: ReturnType<typeof suite.app.inject> | undefined;
    try {
      await suite.waitForBlocked(blocker.pid);
      revoked = suite.app.inject({ method: 'POST', url: `/internal/admin/directory-credentials/${credential.id}/revoke`,
        headers: { authorization: `Bearer ${suite.adminToken}` }, payload: {} });
      // Start the lazy injection, then observe a policy-lock waiter behind the
      // in-flight read rather than relying on a sleep for transaction order.
      const revocation = revoked.then(value => value);
      const deadline = Date.now() + 4000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const rows = await suite.db.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT count(*) >= 2 AS waiting FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0`;
        waiting = rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.release();
      expect((await read).statusCode).toBe(200);
      expect((await revocation).statusCode).toBe(200);
      expect((await suite.app.inject({ url: path, headers: credential.headers })).statusCode).toBe(401);
    } finally { await blocker.release(); await read; }
  });

  it('keeps an actual PostgreSQL authority-store outage as generic 500', async () => {
    const f = await suite.subject();
    const schema = suite.handle.schema;
    await suite.db.$executeRawUnsafe(`REVOKE USAGE ON SCHEMA "${schema}" FROM uoa_admin`);
    try {
      const response = await suite.app.inject({ url: '/profile/me' + query, headers: f.headers });
      expect(response.statusCode).toBe(500);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).not.toContain(f.owner.email!);
    } finally { await suite.db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO uoa_admin`); }
  });
});
