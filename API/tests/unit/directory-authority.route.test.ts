import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/avatar.service.js', () => ({
  resolveAvatar: vi.fn(async () => ({ contentType: 'image/png', body: Buffer.from('synthetic-image') })),
}));

import { registerDirectoryRoutes } from '../../src/routes/directory/index.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { resolveAvatar } from '../../src/services/avatar.service.js';

async function fixture() {
  vi.clearAllMocks();
  const credential = { clientDomainId: 'domain', expiresAt: new Date(Date.now() + 60_000), revokedAt: null as Date | null };
  const target = { status: 'ACTIVE', role: 'member', org: { lifecycleStatus: 'ACTIVE' },
    user: { id: 'subject', name: 'Current display', lifecycleStatus: 'ACTIVE', tokenVersion: 4 } };
  const grant = { id: 'grant', permissions: ['MEMBERSHIP_READ', 'DISPLAY_READ'], revokedAt: null as Date | null };
  const raw = {
    $queryRaw: vi.fn(async () => []),
    directoryCredentialSecret: { findUnique: vi.fn(async () => ({ credentialId: 'credential', expiresAt: credential.expiresAt, credential })) },
    directoryOrganisationGrant: { findUnique: vi.fn(async () => grant) },
    clientDomain: { findUnique: vi.fn(async () => ({ status: 'active' })) },
    orgMember: { findUnique: vi.fn(async () => target) },
    organisation: { findUnique: vi.fn(async () => ({ lifecycleStatus: 'ACTIVE' })) },
    teamMember: { findMany: vi.fn(async () => [{ teamId: 'team', teamRole: 'member' }]) },
    historicalOrganisationIdentityReference: { findUnique: vi.fn(async () => null) },
  };
  const db = { ...raw, $transaction: async (body: (tx: unknown) => Promise<unknown>) => body({ ...raw }) };
  const app = Fastify();
  app.decorateRequest('adminDb', null);
  app.addHook('onRequest', async request => { request.adminDb = db as never; });
  registerErrorHandler(app);
  registerDirectoryRoutes(app);
  return { app, raw, target, grant, credential, headers: { authorization: 'Bearer uoa_dir_' + 'a'.repeat(43) } };
}
const path = '/directory/v1/organisations/exact-org/subjects/subject';

describe('directory HTTP purpose and cache boundaries', () => {
  it('returns live profile-free standing to the separate directory credential', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ url: path + '/standing', headers: f.headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual({ subject: 'subject', organisation_id: 'exact-org', active: true,
        credential_epoch: 4, org_role: 'member', teams: [{ id: 'team', role: 'member' }] });
    } finally { await f.app.close(); }
  });

  it.each(['missing', 'domain-bearer', 'unknown', 'expired', 'revoked'])('refuses a %s credential with no-store', async (mode) => {
    const f = await fixture(); const headers = { ...f.headers };
    if (mode === 'missing') headers.authorization = '';
    if (mode === 'domain-bearer') headers.authorization = 'Bearer ' + 'a'.repeat(64);
    if (mode === 'unknown') f.raw.directoryCredentialSecret.findUnique.mockResolvedValue(null as never);
    if (mode === 'expired') f.credential.expiresAt = new Date(Date.now() - 1);
    if (mode === 'revoked') f.credential.revokedAt = new Date();
    try {
      const response = await f.app.inject({ url: path + '/standing', headers });
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(f.raw.orgMember.findUnique).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });

  it('refuses display when only standing is granted', async () => {
    const f = await fixture(); f.grant.permissions = ['MEMBERSHIP_READ'];
    try {
      const response = await f.app.inject({ url: path + '/display', headers: f.headers });
      expect(response.statusCode).toBe(403);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).not.toContain('Current display');
    } finally { await f.app.close(); }
  });

  it('requires the same current grant to fetch the image', async () => {
    const f = await fixture();
    try {
      const allowed = await f.app.inject({ url: path + '/avatar', headers: f.headers });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers['cache-control']).toBe('private, no-store');
      expect(allowed.headers['content-type']).toContain('image/png');
      expect(resolveAvatar).toHaveBeenCalledOnce();
      f.grant.revokedAt = new Date();
      const revoked = await f.app.inject({ url: path + '/avatar', headers: f.headers });
      expect(revoked.statusCode).toBe(403);
      expect(revoked.headers['cache-control']).toBe('private, no-store');
      expect(resolveAvatar).toHaveBeenCalledOnce();
    } finally { await f.app.close(); }
  });

  it('cannot fetch a removed subject image or disclose its old profile', async () => {
    const f = await fixture(); f.target.status = 'REMOVED';
    try {
      const display = await f.app.inject({ url: path + '/display', headers: f.headers });
      expect(display.json()).toEqual({ id: 'subject', deleted: false, name: 'Former member' });
      const image = await f.app.inject({ url: path + '/avatar', headers: f.headers });
      expect(image.statusCode).toBe(404);
      expect(image.headers['cache-control']).toBe('private, no-store');
      expect(resolveAvatar).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });

  it('keeps dependency outages as generic server failures with no-store', async () => {
    const f = await fixture(); f.raw.directoryCredentialSecret.findUnique.mockRejectedValue(new Error('dependency unavailable'));
    try {
      const response = await f.app.inject({ url: path + '/standing', headers: f.headers });
      expect(response.statusCode).toBe(500);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).not.toContain('dependency unavailable');
    } finally { await f.app.close(); }
  });
});
