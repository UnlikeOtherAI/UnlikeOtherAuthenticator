import type { FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { digestDomainClientHash } from '../../src/utils/client-hash.js';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../src/db/prisma.js', () => ({
  getAdminPrisma: () => state.db, getPrisma: () => state.db,
}));
// Config fetching/signature verification has its own harness. Seed the verified
// result here; the domain bearer, user JWT, epoch and profile services are real.
vi.mock('../../src/middleware/config-verifier.js', () => ({
  configVerifier: async (request: FastifyRequest) => {
    request.config = { domain: 'product.example.com' } as never;
  },
}));
vi.mock('../../src/services/avatar.service.js', () => ({
  resolveAvatar: vi.fn(async () => ({ contentType: 'image/png', body: Buffer.from('synthetic-image') })),
}));

import { registerProfileRoutes } from '../../src/routes/profile/index.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { resolveAvatar } from '../../src/services/avatar.service.js';

const domainCredential = 'a'.repeat(64);
const query = '?domain=product.example.com&config_url=https%3A%2F%2Fproduct.example.com%2Fconfig';
const originalDatabase = process.env.DATABASE_URL;
beforeEach(() => { process.env.DATABASE_URL = 'postgresql://profile-route.unit.invalid/db'; vi.clearAllMocks(); });
afterEach(() => { if (originalDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabase; });

async function fixture() {
  const self = { id: 'self', email: 'current@example.com', name: 'Current Self', lifecycleStatus: 'ACTIVE',
    tokenVersion: 2, twoFaEnabled: false, pronounsPreset: null as string | null,
    pronounsCustom: null as string | null, createdAt: new Date('2026-01-01') };
  const target = { status: 'ACTIVE', user: { id: 'target', name: 'Private target name', lifecycleStatus: 'ACTIVE' } };
  const raw = {
    $queryRaw: vi.fn(async () => []),
    clientDomain: { findUnique: vi.fn(async () => ({ id: 'domain', domain: 'product.example.com', status: 'active',
      secrets: [{ secretDigest: digestDomainClientHash(domainCredential), hashPrefix: 'synthetic' }] })) },
    domainRole: { findUnique: vi.fn(async () => ({ userId: 'self' })) },
    user: { findUnique: vi.fn(async () => self), update: vi.fn(async ({ data }: { data: object }) => Object.assign(self, data)) },
    organisation: { findUnique: vi.fn(async () => ({ lifecycleStatus: 'ACTIVE' })) },
    orgMember: { findMany: vi.fn(async () => [{ orgId: 'org' }]),
      findUnique: vi.fn(async ({ where }: { where: { orgId_userId: { userId: string } } }) =>
        where.orgId_userId.userId === 'self' ? { status: 'ACTIVE', user: self } : target) },
    historicalOrganisationIdentityReference: { findUnique: vi.fn(async () => null) },
  };
  const db = { ...raw, $transaction: async (body: (tx: unknown) => Promise<unknown>) => body({ ...raw }) };
  state.db = db;
  const token = await new SignJWT({ email: 'old@example.com', domain: 'product.example.com', client_id: 'domain',
    role: 'user', tv: 2, org: { org_id: 'org', org_role: 'member', teams: [], team_roles: {} } })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('self').setIssuer('uoa-auth-service')
    .setAudience(ACCESS_TOKEN_AUDIENCE).setIssuedAt().setExpirationTime('5m')
    .sign(new TextEncoder().encode(process.env.SHARED_SECRET!));
  const app = Fastify();
  app.decorateRequest('adminDb', null);
  app.addHook('onRequest', async request => { request.adminDb = db as never; });
  registerErrorHandler(app);
  registerProfileRoutes(app);
  return { app, self, target, raw, headers: { authorization: `Bearer ${domainCredential}`, 'x-uoa-access-token': token } };
}

describe('profile HTTP authority and cache boundaries', () => {
  it('reads canonical self fields using the actual user JWT and live domain bearer', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ url: '/profile/me' + query, headers: f.headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toMatchObject({ id: 'self', email: 'current@example.com', name: 'Current Self' });
      expect(response.body).not.toContain('old@example.com');
      expect(response.body).not.toContain(domainCredential);
    } finally { await f.app.close(); }
  });

  it.each(['missing-user', 'blank-user', 'both-user-credentials', 'wrong-domain-bearer', 'stale-epoch', 'inactive-self'])('refuses %s without returning profile data', async (mode) => {
    const f = await fixture(); const headers: Record<string, string> = { ...f.headers };
    if (mode === 'missing-user') delete headers['x-uoa-access-token'];
    if (mode === 'blank-user') headers['x-uoa-access-token'] = ' ';
    if (mode === 'both-user-credentials') headers['x-uoa-subject-assertion'] = f.headers['x-uoa-access-token'];
    if (mode === 'wrong-domain-bearer') headers.authorization = 'Bearer ' + 'b'.repeat(64);
    if (mode === 'stale-epoch') f.self.tokenVersion++;
    if (mode === 'inactive-self') f.self.lifecycleStatus = 'DISABLED';
    try {
      const response = await f.app.inject({ url: '/profile/me' + query, headers });
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).not.toContain('current@example.com');
      expect(f.raw.user.update).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });

  it('patches name/pronouns and returns canonical values with an invalidation', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ method: 'PATCH', url: '/profile/me' + query, headers: f.headers,
        payload: { name: ' Updated Self ', pronouns_preset: 'custom', pronouns_custom: 'xe/xem' } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toMatchObject({ name: 'Updated Self', pronouns_display: 'xe/xem', email: 'current@example.com' });
      expect(JSON.stringify(f.raw.$queryRaw.mock.calls)).toContain('profile.changed');
    } finally { await f.app.close(); }
  });

  it.each([{ email: 'replacement@example.com' }, { name: ' ' }, {}, { pronouns_preset: 'custom' }])('refuses unsupported/incomplete edit %j without changing the profile', async (patch) => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ method: 'PATCH', url: '/profile/me' + query, headers: f.headers, payload: patch });
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(f.raw.user.update).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });

  it('keeps a removed target neutral and refuses its avatar', async () => {
    const f = await fixture(); f.target.status = 'REMOVED';
    try {
      const path = '/org/organisations/org/users/target/display';
      const display = await f.app.inject({ url: path + query, headers: f.headers });
      expect(display.statusCode).toBe(200);
      expect(display.json()).toEqual({ id: 'target', deleted: false, name: 'Former member' });
      const avatar = await f.app.inject({ url: path + '/avatar' + query, headers: f.headers });
      expect(avatar.statusCode).toBe(404);
      expect(avatar.headers['cache-control']).toBe('private, no-store');
      expect(resolveAvatar).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });

  it('requires the user credential for the image URL too', async () => {
    const f = await fixture();
    try {
      const denied = await f.app.inject({ url: '/profile/me/avatar' + query, headers: { authorization: f.headers.authorization } });
      expect(denied.statusCode).toBe(401);
      const allowed = await f.app.inject({ url: '/profile/me/avatar' + query, headers: f.headers });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers['cache-control']).toBe('private, no-store');
      expect(allowed.headers['x-content-type-options']).toBe('nosniff');
      expect(allowed.headers['content-type']).toContain('image/png');
    } finally { await f.app.close(); }
  });

  it('preserves a live identity dependency failure as 500', async () => {
    const f = await fixture(); f.raw.user.findUnique.mockRejectedValue(new Error('dependency unavailable'));
    try {
      const response = await f.app.inject({ url: '/profile/me' + query, headers: f.headers });
      expect(response.statusCode).toBe(500);
      expect(response.headers['cache-control']).toBe('private, no-store');
    } finally { await f.app.close(); }
  });
});
