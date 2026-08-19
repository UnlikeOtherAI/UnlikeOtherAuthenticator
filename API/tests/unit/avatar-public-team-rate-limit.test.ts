import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/db/prisma.js', () => ({
  getPrisma: vi.fn(),
  getAdminPrisma: vi.fn(),
  connectPrisma: vi.fn(async () => {}),
  disconnectPrisma: vi.fn(async () => {}),
}));

vi.mock('../../src/services/team-avatar.service.js', () => ({
  resolveTeamAvatar: vi.fn(async () => {
    throw new Error('resolveTeamAvatar must not be reached by these tests');
  }),
}));

// A real ResolvedAvatar body so the non-oracle branch can serve without touching avatar services.
vi.mock('../../src/services/avatar-subject.service.js', () => ({
  resolveSubjectAvatar: vi.fn(async () => ({
    source: 'generated',
    contentType: 'image/svg+xml',
    body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    etag: '"test"',
    cacheControl: 'public, max-age=3600',
    filename: 'avatar.svg',
    isSvg: true,
  })),
}));

async function buildApp(): Promise<FastifyInstance> {
  const fastify = (await import('fastify')).default;
  const { registerPublicTeamAvatarRoute } = await import(
    '../../src/routes/avatar/public-team.js'
  );
  const app = fastify({ trustProxy: 1 });
  // Fastify 5 rejects reference-type request decorators ("use the { getter, setter } interface"),
  // so follow the production convention in API/src/plugins/tenant-context.plugin.ts (and the
  // onRequest pattern in org-me.route.test.ts): decorate an inert placeholder, then assign the
  // stub per request in an onRequest hook. Unknown ids fall through to the generated image, so
  // a findFirst that always misses is all the non-oracle branch needs from `adminDb`.
  app.decorateRequest('adminDb', null as unknown as PrismaClient);
  app.addHook('onRequest', async (request) => {
    request.adminDb = {
      team: { findFirst: async () => null },
    } as unknown as PrismaClient;
  });
  registerPublicTeamAvatarRoute(app);
  await app.ready();
  return app;
}

describe('GET /teams/:teamId/avatar global rate limit', () => {
  it('counts requests from many distinct source IPs against the fixed global bucket', async () => {
    // Reset the module registry so this file's limiter windows cannot leak in from other tests
    // (the bucket state is module-level in middleware/rate-limiter.ts).
    vi.resetModules();
    const app = await buildApp();
    try {
      const REQUESTS = 120;

      // Rotating the last X-Forwarded-For hop moves request.ip past the 300/hr per-IP bucket
      // on every request (trustProxy: 1 makes the header hop request.ip), so none of these can
      // be refused by the per-IP key — each one must succeed and consume the global bucket.
      for (let i = 0; i < REQUESTS; i += 1) {
        const res = await app.inject({
          method: 'GET',
          url: `/teams/team-${i}/avatar`,
          remoteAddress: '10.0.0.1',
          headers: {
            'x-forwarded-for': `203.0.${Math.floor(i / 250)}.${i % 250}`,
          },
        });
        expect(res.statusCode).toBe(200);
      }

      // Issuing 20,000 requests to cross the real global ceiling would make this the slowest
      // test in the suite for no extra signal: the honest assertion is on the composed limiter's
      // shared state. A probe limiter reading the route's fixed key (same pattern as
      // auth-rate-limit-global.test.ts) must refuse once its allowance equals the REQUESTS
      // already spent — proving every header-rotated request landed in the one bucket no
      // request input can move. Dynamic import so the probe shares the post-reset module
      // registry with the route under test.
      const { createRateLimiter } = await import('../../src/middleware/rate-limiter.js');
      const probe = createRateLimiter({
        keyBuilder: () => 'public:team-avatar:global',
        limit: REQUESTS,
        windowMs: 60 * 60 * 1000,
      });
      await expect(probe({} as Parameters<typeof probe>[0])).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        statusCode: 429,
      });

      // Sanity: the per-IP key for one of the rotated IPs is at count 1, nowhere near its
      // 300/hr ceiling — so only the global bucket can be what stops a header-rotating flood.
      const ipProbe = createRateLimiter({
        keyBuilder: () => 'public:team-avatar:203.0.0.0',
        limit: 300,
        windowMs: 60 * 60 * 1000,
      });
      await expect(ipProbe({} as Parameters<typeof ipProbe>[0])).resolves.toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
