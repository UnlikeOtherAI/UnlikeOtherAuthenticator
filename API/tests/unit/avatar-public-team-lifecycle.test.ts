import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { registerPublicTeamAvatarRoute } from '../../src/routes/avatar/public-team.js';

const uploaded = Buffer.from('uploaded-team-logo');
vi.mock('../../src/services/team-avatar.service.js', () => ({
  resolveTeamAvatar: vi.fn(async () => ({
    source: 'uploaded', contentType: 'image/png', body: Buffer.from('uploaded-team-logo'),
    etag: '"uploaded"', cacheControl: 'private, no-cache', filename: 'avatar.png', isSvg: false,
  })),
}));

type Lifecycle = 'ACTIVE' | 'DISABLED' | 'DELETING' | 'DELETED';
const apps: ReturnType<typeof fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); vi.clearAllMocks(); });

async function readImage(teamStatus: Lifecycle | null, orgStatus: Lifecycle = 'ACTIVE') {
  const app = fastify();
  apps.push(app);
  app.decorateRequest('adminDb', null as unknown as PrismaClient);
  app.addHook('onRequest', async (request) => {
    request.adminDb = { team: { findFirst: async () => teamStatus === null ? null : {
      lifecycleStatus: teamStatus, org: { lifecycleStatus: orgStatus },
    } } } as unknown as PrismaClient;
  });
  registerPublicTeamAvatarRoute(app);
  return app.inject({ method: 'GET', url: '/teams/team-cross-product/avatar?size=128&v=fresh' });
}

describe('public team image follows entity lifecycle', () => {
  it('serves the uploaded image for an active team without requiring its founding ClientDomain', async () => {
    // No ClientDomain reader exists: the independent tenant, not its old integration, owns the logo.
    const response = await readImage('ACTIVE');
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(uploaded);
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(response.headers['x-uoa-avatar-source']).toBeUndefined();
  });

  it.each(['DISABLED', 'DELETING', 'DELETED'] as const)(
    'hides a %s team or parent behind the same unknown-team image', async (status) => {
      const [team, parent, missing] = await Promise.all([
        readImage(status), readImage('ACTIVE', status), readImage(null),
      ]);
      for (const response of [team, parent, missing]) {
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
        expect(response.headers['x-uoa-avatar-source']).toBeUndefined();
        expect(response.body).toBe(missing.body);
      }
      const { resolveTeamAvatar } = await import('../../src/services/team-avatar.service.js');
      expect(resolveTeamAvatar).not.toHaveBeenCalled();
    },
  );
});
