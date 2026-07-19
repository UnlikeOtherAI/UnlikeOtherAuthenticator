import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { jwtVerify } from 'jose';

import { createApp } from '../../src/app.js';
import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { createAdminDomain } from '../../src/services/domain-secret.service.js';
import { verifyTwoFaChallenge } from '../../src/services/twofactor-challenge.service.js';
import { encryptTwoFaSecret } from '../../src/utils/twofa-secret.js';
import { hashEmailToken } from '../../src/utils/verification-token.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';
import { computeTotp } from '../helpers/totp.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const domain = 'client.example.com';
const configUrl = 'https://client.example.com/auth-config';
const redirectUrl = 'https://client.example.com/oauth/callback';
const codeVerifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const invitedEmail = 'invite-scope@example.com';

function pkceChallenge(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

async function activeClaim(accessToken: string): Promise<unknown> {
  const { payload } = await jwtVerify(
    accessToken,
    new TextEncoder().encode(process.env.SHARED_SECRET!),
    {
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
      audience: ACCESS_TOKEN_AUDIENCE,
    },
  );
  return payload.active;
}

describe.skipIf(!hasDatabase)('invite-bound email workspace token flow', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
    CONFIG_JWKS_URL: process.env.CONFIG_JWKS_URL,
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

  it('accepts, enforces 2FA, and preserves invite scope through refresh rotation', async () => {
    const domainAuth = await createAdminDomain(
      {
        domain,
        clientSecret: 'invite-workspace-test-client-secret',
        actorEmail: 'integration-test@example.com',
      },
      { prisma: handle!.prisma },
    );
    const owner = await handle!.prisma.user.create({
      data: { email: 'owner@example.com', userKey: 'owner@example.com' },
      select: { id: true },
    });
    const org = await handle!.prisma.organisation.create({
      data: {
        domain,
        name: 'Inviting Org',
        slug: 'inviting-org',
        ownerId: owner.id,
        twoFaPolicy: 'REQUIRED',
      },
      select: { id: true },
    });
    await handle!.prisma.orgMember.create({
      data: { orgId: org.id, userId: owner.id, role: 'owner' },
    });
    const team = await handle!.prisma.team.create({
      data: { orgId: org.id, name: 'Invited Team', slug: 'invited-team' },
      select: { id: true },
    });
    await handle!.prisma.teamMember.create({
      data: { teamId: team.id, userId: owner.id, teamRole: 'owner' },
    });

    const totpSecret = 'JBSWY3DPEHPK3PXP';
    const invitedUser = await handle!.prisma.user.create({
      data: {
        email: invitedEmail,
        userKey: invitedEmail,
        twoFaEnabled: true,
        twoFaSecret: encryptTwoFaSecret({
          secret: totpSecret,
          sharedSecret: process.env.SHARED_SECRET!,
        }),
      },
      select: { id: true },
    });
    const invite = await handle!.prisma.teamInvite.create({
      data: {
        orgId: org.id,
        teamId: team.id,
        email: invitedEmail,
        invitedByUserId: owner.id,
        invitedByEmail: 'owner@example.com',
        lastSentAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      },
      select: { id: true },
    });
    const rawToken = 'invite-bound-email-verification-token';
    await handle!.prisma.verificationToken.create({
      data: {
        type: 'VERIFY_EMAIL',
        email: invitedEmail,
        userKey: invitedEmail,
        domain: null,
        configUrl,
        teamInviteId: invite.id,
        tokenHash: hashEmailToken(rawToken, process.env.SHARED_SECRET!),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });

    const configJwt = await signTestConfigJwt(
      baseClientConfigPayload({
        registration_mode: 'passwordless',
        '2fa_enabled': true,
        login_flow: { email_code_enabled: false, workspace_selection: 'auto' },
        org_features: { enabled: true, user_needs_team: true },
      }),
    );
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(configJwt)));

    const app = await createApp();
    await app.ready();
    try {
      const challenge = pkceChallenge(codeVerifier);
      const verified = await app.inject({
        method: 'POST',
        url:
          `/auth/verify-email?config_url=${encodeURIComponent(configUrl)}` +
          `&redirect_url=${encodeURIComponent(redirectUrl)}` +
          `&code_challenge=${challenge}&code_challenge_method=S256`,
        payload: { token: rawToken },
      });
      expect(verified.statusCode, verified.body).toBe(200);
      const verificationBody = verified.json() as {
        twofa_required: boolean;
        twofa_token: string;
      };
      expect(verificationBody.twofa_required).toBe(true);
      const challengeClaims = await verifyTwoFaChallenge({
        token: verificationBody.twofa_token,
        sharedSecret: process.env.SHARED_SECRET!,
        audience: process.env.AUTH_SERVICE_IDENTIFIER!,
      });
      const exactActive = { orgId: org.id, teamId: team.id };
      expect(challengeClaims).toMatchObject(exactActive);

      const completed = await app.inject({
        method: 'POST',
        url: `/2fa/verify?config_url=${encodeURIComponent(configUrl)}`,
        payload: {
          twofa_token: verificationBody.twofa_token,
          code: computeTotp({ secret: totpSecret, nowMs: Date.now() }),
        },
      });
      expect(completed.statusCode, completed.body).toBe(200);
      const code = (completed.json() as { code: string }).code;
      expect(code).toBeTruthy();

      const acceptedInvite = await handle!.prisma.teamInvite.findUniqueOrThrow({
        where: { id: invite.id },
        select: { acceptedAt: true, acceptedUserId: true },
      });
      expect(acceptedInvite.acceptedAt).not.toBeNull();
      expect(acceptedInvite.acceptedUserId).toBe(invitedUser.id);
      const storedCode = await handle!.prisma.authorizationCode.findFirstOrThrow({
        where: { userId: invitedUser.id, usedAt: null },
        select: { orgId: true, teamId: true },
      });
      expect(storedCode).toEqual(exactActive);

      const authorization = `Bearer ${domainAuth.clientHash}`;
      const tokenResponse = await app.inject({
        method: 'POST',
        url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
        headers: { authorization },
        payload: { code, redirect_url: redirectUrl, code_verifier: codeVerifier },
      });
      expect(tokenResponse.statusCode, tokenResponse.body).toBe(200);
      const firstPair = tokenResponse.json() as {
        access_token: string;
        refresh_token: string;
      };
      expect(await activeClaim(firstPair.access_token)).toEqual(exactActive);

      const firstRefresh = await handle!.prisma.refreshToken.findFirstOrThrow({
        where: { userId: invitedUser.id, revokedAt: null },
        select: { id: true, orgId: true, teamId: true },
      });
      expect(firstRefresh).toMatchObject(exactActive);

      const refreshed = await app.inject({
        method: 'POST',
        url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
        headers: { authorization },
        payload: { grant_type: 'refresh_token', refresh_token: firstPair.refresh_token },
      });
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      expect(
        await activeClaim((refreshed.json() as { access_token: string }).access_token),
      ).toEqual(exactActive);

      const refreshRows = await handle!.prisma.refreshToken.findMany({
        where: { userId: invitedUser.id },
        select: { id: true, orgId: true, teamId: true, revokedAt: true },
      });
      expect(refreshRows).toHaveLength(2);
      expect(refreshRows.every((row) => row.orgId === org.id && row.teamId === team.id)).toBe(true);
      expect(refreshRows.find((row) => row.id === firstRefresh.id)?.revokedAt).not.toBeNull();
      expect(refreshRows.find((row) => row.id !== firstRefresh.id)?.revokedAt).toBeNull();
    } finally {
      await app.close();
    }
  });
});
