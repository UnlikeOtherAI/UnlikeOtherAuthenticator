import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';

const control = vi.hoisted(() => ({ controlNessieAutomaticMembership: vi.fn() }));
vi.mock('../../src/services/nessie-automatic-membership-control.service.js', () => control);
const prisma = vi.hoisted(() => ({
  orgMember: { findUnique: vi.fn() },
  teamMember: { findFirst: vi.fn() },
  orgAuditLog: { create: vi.fn() },
}));
vi.mock('../../src/db/prisma.js', async () => ({
  ...(await vi.importActual<typeof import('../../src/db/prisma.js')>('../../src/db/prisma.js')),
  getAdminPrisma: () => prisma,
}));

const secret = 'admin-token-secret-with-enough-length';
const domain = 'admin.example.com';

async function token(role: 'superuser' | 'user'): Promise<string> {
  return new SignJWT({ email: 'admin@example.com', domain, client_id: `admin:${domain}`, role, tv: 0 })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('uoa-admin-sub').setIssuer('uoa-auth-service')
    .setAudience(ACCESS_TOKEN_AUDIENCE).setIssuedAt().setExpirationTime('30m')
    .sign(new TextEncoder().encode(secret));
}

describe('internal automatic membership control routes', () => {
  const priorDomain = process.env.ADMIN_AUTH_DOMAIN;
  beforeEach(() => {
    process.env.ADMIN_AUTH_DOMAIN = domain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = secret;
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    control.controlNessieAutomaticMembership.mockReset();
    prisma.orgMember.findUnique.mockResolvedValue({ role: 'owner', status: 'ACTIVE' });
    prisma.teamMember.findFirst.mockResolvedValue({ id: 'team-member' });
    prisma.orgAuditLog.create.mockResolvedValue({ id: 'audit' });
  });
  afterEach(() => {
    if (priorDomain === undefined) Reflect.deleteProperty(process.env, 'ADMIN_AUTH_DOMAIN');
    else process.env.ADMIN_AUTH_DOMAIN = priorDomain;
  });

  it('binds the exact UOA actor and team target before proxying an action', async () => {
    control.controlNessieAutomaticMembership.mockResolvedValue({ rules: [] });
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST', url: '/internal/admin/organisations/org-1/teams/team-1/automatic-membership',
        headers: { authorization: `Bearer ${await token('superuser')}` },
        payload: { action: 'verify', payload: { rule_id: 'rule-1' } },
      });
      expect(response.statusCode).toBe(200);
      expect(control.controlNessieAutomaticMembership).toHaveBeenCalledWith({
        uoaActorSub: 'uoa-admin-sub', externalOrgId: 'org-1', externalTeamId: 'team-1',
        scope: 'team', action: 'verify', payload: { rule_id: 'rule-1' },
      });
      expect(prisma.teamMember.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ teamId: 'team-1', userId: 'uoa-admin-sub', status: 'ACTIVE' }),
      }));
    } finally { await app.close(); }
  });

  it('refuses a non-superuser before it reaches Nessie', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: '/internal/admin/organisations/org-1/automatic-membership', headers: { authorization: `Bearer ${await token('user')}` } });
      expect(response.statusCode).toBe(403);
      expect(control.controlNessieAutomaticMembership).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
