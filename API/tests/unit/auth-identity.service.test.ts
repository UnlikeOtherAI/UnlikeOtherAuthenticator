import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import {
  mapAuthMethodToProvider,
  recordAuthIdentity,
} from '../../src/services/auth-identity.service.js';

const env = { DATABASE_URL: 'postgresql://localhost/test' } as ReturnType<
  typeof import('../../src/config/env.js').getEnv
>;

describe('mapAuthMethodToProvider', () => {
  it('passes social provider names through', () => {
    for (const provider of ['google', 'github', 'microsoft', 'apple', 'facebook', 'linkedin']) {
      expect(mapAuthMethodToProvider(provider)).toBe(provider);
    }
  });

  it('collapses every email-based method to "email"', () => {
    for (const method of [
      'email_password',
      'verify_email',
      'verify_email_set_password',
      'login_link',
      'anything-else',
    ]) {
      expect(mapAuthMethodToProvider(method)).toBe('email');
    }
  });

  it('is case-insensitive', () => {
    expect(mapAuthMethodToProvider('GOOGLE')).toBe('google');
  });
});

describe('recordAuthIdentity', () => {
  it('upserts on (userId, provider) with normalized email and verified/lastLogin timestamps', async () => {
    const now = new Date('2026-07-07T00:00:00.000Z');
    const upsert = vi.fn().mockResolvedValue({ id: 'ai-1' });
    const prisma = { authIdentity: { upsert } } as unknown as PrismaClient;

    // The email is normalized to lowercase; providerSubject is preserved verbatim (social OAuth
    // subjects are case-sensitive), and the login-log caller already passes a lowercased email here.
    await recordAuthIdentity(
      { userId: 'user-1', provider: 'email', providerSubject: 'user@example.com', email: 'User@Example.com' },
      { env, prisma, now: () => now },
    );

    expect(upsert).toHaveBeenCalledWith({
      where: { userId_provider: { userId: 'user-1', provider: 'email' } },
      create: {
        userId: 'user-1',
        provider: 'email',
        providerSubject: 'user@example.com',
        email: 'user@example.com',
        providerTenant: null,
        verifiedAt: now,
        lastLoginAt: now,
      },
      update: {
        providerSubject: 'user@example.com',
        email: 'user@example.com',
        lastLoginAt: now,
      },
    });
  });

  it('falls back to the email as providerSubject when subject is blank', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'ai-2' });
    const prisma = { authIdentity: { upsert } } as unknown as PrismaClient;

    await recordAuthIdentity(
      { userId: 'user-1', provider: 'google', providerSubject: '  ', email: 'a@b.com' },
      { env, prisma, now: () => new Date('2026-07-07T00:00:00.000Z') },
    );

    expect(upsert.mock.calls[0][0].create.providerSubject).toBe('a@b.com');
  });

  it('no-ops when the database is disabled', async () => {
    const upsert = vi.fn();
    const prisma = { authIdentity: { upsert } } as unknown as PrismaClient;

    await recordAuthIdentity(
      { userId: 'user-1', provider: 'email', providerSubject: 'a@b.com', email: 'a@b.com' },
      { env: { DATABASE_URL: undefined } as typeof env, prisma },
    );

    expect(upsert).not.toHaveBeenCalled();
  });
});
