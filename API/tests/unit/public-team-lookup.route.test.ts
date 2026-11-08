import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/db/prisma.js', () => ({
  getPrisma: vi.fn(),
  getAdminPrisma: vi.fn(),
  connectPrisma: vi.fn(async () => {}),
  disconnectPrisma: vi.fn(async () => {}),
}));

const updatedAt = new Date('2026-11-08T10:00:00.000Z');

async function buildApp(findMany = vi.fn(async (args: { where: { id: { in: string[] } } }) =>
  args.where.id.in.filter((id) => id.startsWith('team-')).map((id) => ({
    id, name: `Name ${id}`, slug: id, updatedAt,
    org: { id: 'org-1', name: 'Acme', slug: 'acme' },
  })),
)): Promise<{ app: FastifyInstance; findMany: typeof findMany }> {
  // The limiter windows are module-level; a fresh registry keeps each test's buckets its own.
  vi.resetModules();
  const fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/middleware/error-handler.js');
  const { registerPublicTeamLookupRoute } = await import('../../src/routes/public/team-lookup.js');
  const app = fastify({ trustProxy: ['loopback', 'linklocal'] });
  app.decorateRequest('adminDb', null as unknown as PrismaClient);
  app.addHook('onRequest', async (request) => {
    request.adminDb = { team: { findMany } } as unknown as PrismaClient;
  });
  registerErrorHandler(app);
  registerPublicTeamLookupRoute(app);
  await app.ready();
  return { app, findMany };
}

function lookup(app: FastifyInstance, body: unknown, remoteAddress = '198.51.100.7') {
  return app.inject({ method: 'POST', url: '/public/teams/lookup', payload: body as object, remoteAddress });
}

describe('POST /public/teams/lookup', () => {
  it('needs no credential and returns only display fields, omitting unknown ids', async () => {
    const { app } = await buildApp();
    try {
      const response = await lookup(app, { teamIds: ['team-a', 'unknown-id', 'team-b'] });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.json() as { teams: Array<Record<string, unknown>> };
      expect(Object.keys(body)).toEqual(['teams']);
      expect(body.teams.map((team) => team.teamId)).toEqual(['team-a', 'team-b']);
      for (const team of body.teams) {
        expect(Object.keys(team).sort()).toEqual(
          ['avatarUrl', 'orgId', 'orgName', 'orgSlug', 'teamId', 'teamName', 'teamSlug'],
        );
      }
      expect(body.teams[0]).toMatchObject({
        teamName: 'Name team-a', orgName: 'Acme', orgSlug: 'acme',
        avatarUrl: `/teams/team-a/avatar?v=${updatedAt.getTime().toString(36)}`,
      });
    } finally {
      await app.close();
    }
  });

  it('accepts 50 ids and refuses 51, unknown body fields and non-string ids', async () => {
    const { app, findMany } = await buildApp();
    try {
      const fifty = Array.from({ length: 50 }, (_, i) => `team-${i}`);
      const ok = await lookup(app, { teamIds: fifty });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { teams: unknown[] }).teams).toHaveLength(50);
      findMany.mockClear();

      for (const body of [
        { teamIds: [...fifty, 'team-50'] },
        { teamIds: ['team-a'], include: 'members' },
        { teamIds: [42] },
        { teamIds: ['x'.repeat(65)] },
        { teamIds: 'team-a' },
        {},
      ]) {
        const refused = await lookup(app, body);
        expect(refused.statusCode).toBe(400);
        expect(refused.json()).toMatchObject({ error: 'Request failed' });
      }
      expect(findMany).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('limits each IP to 1,200 requests a minute, refusing before any database read', async () => {
    const { app, findMany } = await buildApp();
    try {
      for (let i = 0; i < 1_200; i += 1) {
        const response = await lookup(app, { teamIds: ['team-a'] });
        expect(response.statusCode).toBe(200);
      }
      findMany.mockClear();

      const limited = await lookup(app, { teamIds: ['team-a'] });
      expect(limited.statusCode).toBe(429);
      expect(findMany).not.toHaveBeenCalled();

      // Another server is not held back by the first one's budget.
      const other = await lookup(app, { teamIds: ['team-a'] }, '198.51.100.8');
      expect(other.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('counts header-rotated source IPs against one global bucket no request input can move', async () => {
    const { app } = await buildApp();
    try {
      const REQUESTS = 100;
      for (let i = 0; i < REQUESTS; i += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/public/teams/lookup',
          payload: { teamIds: ['team-a'] },
          remoteAddress: '10.0.0.1',
          headers: { 'x-forwarded-for': `203.0.113.${i}` },
        });
        expect(response.statusCode).toBe(200);
      }

      // Same probe pattern as the public team-avatar test: crossing the real 6,000/minute ceiling
      // adds no signal, so read the shared bucket through its fixed key.
      const { createRateLimiter } = await import('../../src/middleware/rate-limiter.js');
      const probe = createRateLimiter({
        keyBuilder: () => 'public:team-lookup:global',
        limit: REQUESTS,
        windowMs: 60 * 1000,
      });
      await expect(probe({} as Parameters<typeof probe>[0])).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        statusCode: 429,
      });
    } finally {
      await app.close();
    }
  });
});
