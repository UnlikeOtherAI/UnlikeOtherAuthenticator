import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { createAdminDomain } from '../../src/services/domain-secret.service.js';
import { hashEmailToken } from '../../src/utils/verification-token.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const domain = 'client.example.com';
const configUrl = 'https://client.example.com/auth-config';
const invitedEmail = 'already-registered@example.com';

/**
 * An invitation opened from a mailbox has no PKCE verifier. For an address that
 * already has an account the token is a LOGIN_LINK, which used to fall through
 * to a bare login form: the invitation was never consumed, and the form's social
 * buttons then failed outright for want of PKCE. The invitee could never join.
 */
describe.skipIf(!hasDatabase)('email invitation for an account that already exists', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
  };

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
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

  it('accepts the invitation from the mail link alone, with no PKCE anywhere', async () => {
    await createAdminDomain(
      {
        domain,
        clientSecret: 'existing-account-invite-client-secret-123',
        actorEmail: 'integration-test@example.com',
      },
      { prisma: handle!.prisma },
    );
    const owner = await handle!.prisma.user.create({
      data: { email: 'inviter@example.com', userKey: 'inviter@example.com' },
      select: { id: true },
    });
    const org = await handle!.prisma.organisation.create({
      data: { domain, name: 'Hugo Org', slug: 'hugo-org', ownerId: owner.id },
      select: { id: true },
    });
    await handle!.prisma.orgMember.create({
      data: { orgId: org.id, userId: owner.id, role: 'owner' },
    });
    const team = await handle!.prisma.team.create({
      data: { orgId: org.id, name: 'Hugo Team', slug: 'hugo-team' },
      select: { id: true },
    });
    await handle!.prisma.teamMember.create({
      data: { teamId: team.id, userId: owner.id, teamRole: 'owner' },
    });

    // The invitee signed up long before the invitation, which is what makes
    // their token a LOGIN_LINK rather than a registration token.
    const invitedUser = await handle!.prisma.user.create({
      data: { email: invitedEmail, userKey: invitedEmail },
      select: { id: true, tokenVersion: true },
    });
    const invite = await handle!.prisma.teamInvite.create({
      data: {
        orgId: org.id,
        teamId: team.id,
        email: invitedEmail,
        invitedByUserId: owner.id,
        invitedByEmail: 'inviter@example.com',
        lastSentAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      },
      select: { id: true },
    });
    const rawToken = 'existing-account-invite-token-from-the-mailbox';
    await handle!.prisma.verificationToken.create({
      data: {
        type: 'LOGIN_LINK',
        email: invitedEmail,
        userKey: invitedEmail,
        domain: null,
        configUrl,
        teamInviteId: invite.id,
        tokenHash: hashEmailToken(rawToken, process.env.SHARED_SECRET!),
        expiresAt: new Date(Date.now() + 10 * 60_000),
        userId: invitedUser.id,
        tokenVersion: invitedUser.tokenVersion,
      },
    });

    const configJwt = await signTestConfigJwt(
      baseClientConfigPayload({
        enabled_auth_methods: ['email_password', 'google'],
        org_features: { enabled: true, user_needs_team: true },
      }),
    );
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(configJwt)));

    const app = await createApp();
    await app.ready();
    try {
      // Exactly what the invitation email's Accept button leads to: a token and
      // a config_url, and nothing else.
      const landing = await app.inject({
        method: 'GET',
        url:
          '/auth/email/link' +
          `?config_url=${encodeURIComponent(configUrl)}` +
          `&token=${encodeURIComponent(rawToken)}`,
        headers: { accept: 'text/html' },
      });

      expect(landing.statusCode, landing.body).toBe(200);
      expect(landing.body).toContain('Invitation accepted');
      expect(landing.body).toContain('Hugo Team');
      // The old behaviour: a sign-in form whose Google button then 400s.
      expect(landing.body).not.toContain('Sign in');

      const membership = await handle!.prisma.teamMember.findFirst({
        where: { teamId: team.id, userId: invitedUser.id },
        select: { status: true },
      });
      expect(membership?.status).toBe('ACTIVE');

      const orgMembership = await handle!.prisma.orgMember.findFirst({
        where: { orgId: org.id, userId: invitedUser.id },
        select: { status: true },
      });
      expect(orgMembership?.status).toBe('ACTIVE');

      const accepted = await handle!.prisma.teamInvite.findUnique({
        where: { id: invite.id },
        select: { acceptedAt: true },
      });
      expect(accepted?.acceptedAt).not.toBeNull();

      // Single use: the same link cannot be replayed.
      const replay = await app.inject({
        method: 'GET',
        url:
          '/auth/email/link' +
          `?config_url=${encodeURIComponent(configUrl)}` +
          `&token=${encodeURIComponent(rawToken)}`,
        headers: { accept: 'text/html' },
        remoteAddress: '203.0.113.20',
      });
      expect(replay.body).not.toContain('Invitation accepted');
    } finally {
      await app.close();
    }
  });
});
