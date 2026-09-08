import { beforeEach, expect, it, vi } from 'vitest';

import { validateRegistrationEmailLandingToken } from '../../src/services/auth-registration-email-link.service.js';
import { testUiTheme } from '../helpers/test-config.js';

const config = {
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
} as const;

function inviteToken(overrides?: {
  approvalStatus?: string;
  inviteExpiresAt?: Date;
  tokenExpiresAt?: Date;
  type?: string;
}) {
  return {
    type: overrides?.type ?? 'VERIFY_EMAIL_SET_PASSWORD',
    configUrl: 'https://client.example.com/auth-config',
    expiresAt: overrides?.tokenExpiresAt ?? new Date('2099-01-01T00:00:00.000Z'),
    teamInviteId: 'invite-1',
    tokenVersion: null,
    usedAt: null,
    userId: null,
    userKey: 'invitee@example.com',
    teamInvite: {
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
      expiresAt: overrides?.inviteExpiresAt ?? new Date('2099-01-01T00:00:00.000Z'),
      approvalStatus: overrides?.approvalStatus ?? 'NOT_REQUIRED',
    },
  };
}

async function validate(row: ReturnType<typeof inviteToken>) {
  return validateRegistrationEmailLandingToken(
    {
      token: 'token-123',
      configUrl: 'https://client.example.com/auth-config',
      config,
    },
    {
      prisma: {
        verificationToken: { findUnique: vi.fn().mockResolvedValue(row) },
        user: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
    },
  );
}

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://example.invalid/db';
  process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
});

it('classifies an elapsed durable invite as expired while its PKCE email token remains live', async () => {
  await expect(
    validate(inviteToken({ inviteExpiresAt: new Date('2000-01-01T00:00:00.000Z') })),
  ).rejects.toMatchObject({ statusCode: 400, message: 'INVITE_EXPIRED' });
});

it('classifies a pending invitation as invalid even when its deadline also elapsed', async () => {
  await expect(
    validate(
      inviteToken({
        approvalStatus: 'PENDING',
        inviteExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
      }),
    ),
  ).rejects.toMatchObject({ statusCode: 400, message: 'INVITE_INVALID' });
});

it('classifies an invalid invitation token type as invalid before considering expiry', async () => {
  await expect(
    validate(
      inviteToken({
        type: 'PASSWORD_RESET',
        tokenExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
      }),
    ),
  ).rejects.toMatchObject({ statusCode: 400, message: 'INVITE_INVALID' });
});
