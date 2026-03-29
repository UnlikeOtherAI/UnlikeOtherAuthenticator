import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import { declineTeamInviteByToken } from '../../src/services/team-invite.service.token.js';
import { testUiTheme } from '../helpers/test-config.js';

function makeConfig(): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: testUiTheme(),
    language_config: 'en',
    user_scope: 'global',
    allow_registration: true,
    registration_mode: 'password_required',
    '2fa_enabled': false,
    debug_enabled: false,
  } as ClientConfig;
}

it('declines an invite token and invalidates linked unused tokens', async () => {
  const tx = {
    verificationToken: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'token-row-1',
        type: 'VERIFY_EMAIL_SET_PASSWORD',
        configUrl: 'https://client.example.com/auth-config',
        teamInviteId: 'invite-1',
        expiresAt: new Date('2026-04-01T00:10:00.000Z'),
        usedAt: null,
        teamInvite: {
          id: 'invite-1',
          inviteName: 'Invited User',
          email: 'invitee@example.com',
          acceptedAt: null,
          declinedAt: null,
          revokedAt: null,
          team: { name: 'Core Team' },
          org: { name: 'Acme' },
        },
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    teamInvite: {
      update: vi.fn().mockResolvedValue({ id: 'invite-1' }),
    },
    $transaction: vi.fn(async (callback: (value: PrismaClient) => Promise<unknown>) =>
      callback(tx as unknown as PrismaClient),
    ),
  } as unknown as PrismaClient;

  const result = await declineTeamInviteByToken(
    {
      token: 'token-123',
      configUrl: 'https://client.example.com/auth-config',
      config: makeConfig(),
    },
    {
      env: {
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: 3000,
        PUBLIC_BASE_URL: 'https://auth.example.com',
        LOG_LEVEL: 'info',
        SHARED_SECRET: 'test-shared-secret',
        AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
        DATABASE_URL: 'postgres://example.invalid/db',
        ACCESS_TOKEN_TTL: '30m',
        LOG_RETENTION_DAYS: 90,
        AI_TRANSLATION_PROVIDER: 'disabled',
        OPENAI_API_KEY: undefined,
        OPENAI_MODEL: undefined,
      },
      prisma: tx,
      sharedSecret: 'test-shared-secret',
      now: () => new Date('2026-04-01T00:00:00.000Z'),
    },
  );

  expect(result).toMatchObject({
    email: 'invitee@example.com',
    teamName: 'Core Team',
    organisationName: 'Acme',
  });
  expect(tx.teamInvite.update).toHaveBeenCalledWith({
    where: { id: 'invite-1' },
    data: { declinedAt: new Date('2026-04-01T00:00:00.000Z') },
    select: { id: true },
  });
  expect(tx.verificationToken.updateMany).toHaveBeenCalledWith({
    where: {
      teamInviteId: 'invite-1',
      usedAt: null,
    },
    data: {
      usedAt: new Date('2026-04-01T00:00:00.000Z'),
    },
  });
});
