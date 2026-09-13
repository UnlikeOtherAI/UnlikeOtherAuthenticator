import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { createAdminDomain } from '../../src/services/domain-secret.service.js';
import { hashEmailToken } from '../../src/utils/verification-token.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
  testUiTheme,
} from '../helpers/test-config.js';
import { createRlsTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const domain = 'client.example.com';
const configUrl = 'https://client.example.com/auth-config';
const allowedRedirectUrl = 'https://client.example.com/login';

/**
 * F5: the terminal page of a mail-bound invitation is the last thing the invitee sees, and
 * until now it offered no way into the product at all. It may only offer one when the link
 * carries a `redirect_url` the client's own config lists — the page must never become a
 * redirector to an address chosen by whoever composed the URL.
 */
describe.skipIf(!hasDatabase)('invitation terminal page continue link', () => {
  let handle: Awaited<ReturnType<typeof createRlsTestDb>>;

  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
  };

  beforeAll(async () => {
    handle = await createRlsTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.appDatabaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.adminDatabaseUrl;
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';

    await createAdminDomain(
      {
        domain,
        clientSecret: 'invite-continue-link-client-secret-12345',
        actorEmail: 'integration-test@example.com',
      },
      { prisma: handle.prisma },
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (handle) await handle.cleanup();
  });

  /** One org/team plus one already-registered invitee holding a live LOGIN_LINK invitation. */
  async function seedInvitation(tag: string): Promise<string> {
    const prisma = handle!.prisma;
    const owner = await prisma.user.create({
      data: { email: `inviter-${tag}@example.com`, userKey: `inviter-${tag}@example.com` },
      select: { id: true },
    });
    const org = await prisma.organisation.create({
      data: { domain, name: `Org ${tag}`, slug: `org-${tag}`, ownerId: owner.id },
      select: { id: true },
    });
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: 'owner' } });
    const team = await prisma.team.create({
      data: { orgId: org.id, name: `Team ${tag}`, slug: `team-${tag}` },
      select: { id: true },
    });
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: owner.id, teamRole: 'owner' },
    });

    const email = `invitee-${tag}@example.com`;
    const invitedUser = await prisma.user.create({
      data: { email, userKey: email },
      select: { id: true, tokenVersion: true },
    });
    const invite = await prisma.teamInvite.create({
      data: {
        orgId: org.id,
        teamId: team.id,
        email,
        invitedByUserId: owner.id,
        invitedByEmail: `inviter-${tag}@example.com`,
        lastSentAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      },
      select: { id: true },
    });

    const rawToken = `invite-continue-link-token-${tag}`;
    await prisma.verificationToken.create({
      data: {
        type: 'LOGIN_LINK',
        email,
        userKey: email,
        domain: null,
        configUrl,
        teamInviteId: invite.id,
        tokenHash: hashEmailToken(rawToken, process.env.SHARED_SECRET!),
        expiresAt: new Date(Date.now() + 10 * 60_000),
        userId: invitedUser.id,
        tokenVersion: invitedUser.tokenVersion,
      },
    });
    return rawToken;
  }

  function landingUrl(token: string, redirectUrl?: string): string {
    const query = new URLSearchParams();
    query.set('config_url', configUrl);
    query.set('token', token);
    if (redirectUrl) query.set('redirect_url', redirectUrl);
    return `/auth/email/link?${query.toString()}`;
  }

  it('offers "Continue to <product>" only for an allow-listed redirect_url', async () => {
    const configJwt = await signTestConfigJwt(
      baseClientConfigPayload({
        redirect_urls: [allowedRedirectUrl, 'https://client.example.com/oauth/callback'],
        ui_theme: { ...testUiTheme(), logo: { url: '', alt: 'Nessie' } },
        org_features: { enabled: true, user_needs_team: true },
      }),
    );
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(configJwt)));

    const allowedToken = await seedInvitation('allowed');
    const unlistedToken = await seedInvitation('unlisted');
    const plainToken = await seedInvitation('plain');

    const app = await createApp();
    await app.ready();
    try {
      const allowed = await app.inject({
        method: 'GET',
        url: landingUrl(allowedToken, allowedRedirectUrl),
        headers: { accept: 'text/html' },
      });
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(allowed.body).toContain('Invitation accepted');
      expect(allowed.body).toContain('Continue to Nessie');
      expect(allowed.body).toContain(`href="${allowedRedirectUrl}"`);

      // An unlisted target is dropped, not rendered and not rejected: the invitation is still
      // accepted, the page simply reads exactly as it does without the parameter.
      const unlisted = await app.inject({
        method: 'GET',
        url: landingUrl(unlistedToken, 'https://evil.example.com/phish'),
        headers: { accept: 'text/html' },
        remoteAddress: '203.0.113.21',
      });
      expect(unlisted.statusCode, unlisted.body).toBe(200);
      expect(unlisted.body).toContain('Invitation accepted');
      expect(unlisted.body).not.toContain('Continue to');
      expect(unlisted.body).not.toContain('evil.example.com');
      expect(unlisted.body).toContain('You can close this window and sign in.');

      // No redirect_url at all: unchanged behaviour, and never the config's first entry.
      const plain = await app.inject({
        method: 'GET',
        url: landingUrl(plainToken),
        headers: { accept: 'text/html' },
        remoteAddress: '203.0.113.22',
      });
      expect(plain.statusCode, plain.body).toBe(200);
      expect(plain.body).toContain('Invitation accepted');
      expect(plain.body).not.toContain('Continue to');
    } finally {
      await app.close();
    }
  });
});
