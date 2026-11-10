import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { machineHarness, type MachineHarness } from '../helpers/machine-fixture.js';

describe('machine v1 operator retirement through canonical first-party Admin HTTP authorization', () => {
  let h: MachineHarness;
  beforeAll(async () => { h = await machineHarness(); });
  afterAll(async () => { await h?.cleanup(); });
  async function operator() {
    const email = `operator-${randomUUID()}@example.test`;
    const user = await h.db.prisma.user.create({ data: { userKey: email, email } });
    await h.db.prisma.domainRole.create({ data: { userId: user.id, domain: 'admin.example.com', role: 'SUPERUSER' } });
    // Canonical signed first-party fixture ticket, never a production login or native proof.
    const token = await new SignJWT({ email: user.email, domain: 'admin.example.com', client_id: 'admin:admin.example.com', role: 'superuser', tv: user.tokenVersion })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuer(process.env.AUTH_SERVICE_IDENTIFIER!)
      .setAudience(ACCESS_TOKEN_AUDIENCE).setIssuedAt().setExpirationTime('10m')
      .sign(new TextEncoder().encode(process.env.ADMIN_ACCESS_TOKEN_SECRET!));
    return { user, token };
  }
  function admin(subject: string, token: string, body?: object) {
    return h.app.inject({ method: body ? 'POST' : 'GET', url: `/internal/admin/users/${subject}/machines${body ? '/revoke' : ''}`,
      headers: { authorization: `Bearer ${token}` }, ...(body ? { payload: body } : {}) });
  }

  it('requires current first-party operator authority and returns canonical scope metadata without credentials', async () => {
    const f = await h.fixture(); const grant = await f.enrolled(); const actor = await operator();
    expect((await admin(f.user.id, h.bearer)).statusCode).toBe(401);
    const inventory = await admin(f.user.id, actor.token);
    expect(inventory.statusCode, inventory.body).toBe(200);
    expect(inventory.json().data).toContainEqual(expect.objectContaining({ enrollment_id: grant.enrollmentId,
      organization_name: f.org.name, team_name: f.team.name, decision: 'allowed' }));
    expect(inventory.body).not.toContain(grant.operation.credential);
    expect(inventory.body).not.toContain('public_key');
    await h.db.prisma.domainRole.delete({ where: { domain_userId: { domain: 'admin.example.com', userId: actor.user.id } } });
    expect((await admin(f.user.id, actor.token, { enrollment_id: grant.enrollmentId })).statusCode).toBe(403);
    expect((await f.operate('validate', grant.operation)).json().decision.decision).toBe('allowed');
  });

  it('retires one exact device, then all subject devices across teams while preserving other people and human epochs', async () => {
    const f = await h.fixture(); const one = await f.enrolled();
    const team = await h.db.prisma.team.create({ data: { orgId: f.org.id, name: 'Fictional second team', slug: 'second' } });
    await h.db.prisma.teamMember.create({ data: { userId: f.user.id, teamId: team.id } });
    const two = await f.enrolled({ request_id: randomUUID(), binding_id: randomUUID(), team_id: team.id });
    const other = await h.fixture(); const unaffected = await other.enrolled(); const actor = await operator();
    expect((await admin(f.user.id, actor.token, { enrollment_id: one.enrollmentId })).statusCode).toBe(200);
    expect((await f.operate('validate', one.operation)).json().decision.reason).toBe('device_revoked');
    expect((await f.operate('validate', two.operation)).json().decision.decision).toBe('allowed');
    expect((await admin(f.user.id, actor.token, {})).statusCode).toBe(200);
    expect((await f.operate('validate', { ...two.operation, request_id: randomUUID() })).json().decision.reason).toBe('all_devices_revoked');
    expect((await other.operate('validate', unaffected.operation)).json().decision.decision).toBe('allowed');
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: f.user.id } })).tokenVersion).toBe(f.user.tokenVersion);
    expect(await h.db.prisma.adminAuditLog.count({ where: { action: 'machine.revoked', actorEmail: actor.user.email! } })).toBe(2);
  });

  it('rejects an operator whose global epoch changed after their ticket was issued', async () => {
    const f = await h.fixture(); const grant = await f.enrolled(); const actor = await operator();
    await h.db.prisma.user.update({ where: { id: actor.user.id }, data: { tokenVersion: { increment: 1 } } });
    expect((await admin(f.user.id, actor.token, {})).statusCode).toBe(401);
    expect((await f.operate('validate', grant.operation)).json().decision.decision).toBe('allowed');
  });
});
