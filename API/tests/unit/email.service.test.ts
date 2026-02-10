import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/config/env.js';
import { createEmailProvider } from '../../src/services/email.service.js';

function baseEnv(overrides?: Partial<Env>): Env {
  return {
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
    ...overrides,
  };
}

describe('createEmailProvider', () => {
  it('defaults to the disabled provider when EMAIL_PROVIDER is unset', async () => {
    const provider = createEmailProvider(baseEnv());
    await expect(
      provider.send({ to: 't@example.com', subject: 's', text: 'hello' }),
    ).resolves.toBeUndefined();
  });

  it('creates an smtp provider that errors when SMTP_HOST is missing', async () => {
    const provider = createEmailProvider(baseEnv({ EMAIL_PROVIDER: 'smtp', EMAIL_FROM: 'noreply@example.com' }));
    await expect(
      provider.send({ to: 't@example.com', from: 'noreply@example.com', subject: 's', text: 'hello' }),
    ).rejects.toThrow(/SMTP_HOST/);
  });

  it('creates an smtp provider that sends mail via nodemailer', async () => {
    const sendMail = vi.fn(async () => ({ messageId: 'm1' }));
    const createTransport = vi.fn(() => ({ sendMail }));
    const nodemailerStub = { createTransport };

    const env = baseEnv({
      EMAIL_PROVIDER: 'smtp',
      EMAIL_FROM: 'noreply@example.com',
      EMAIL_REPLY_TO: 'support@example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 2525,
      SMTP_SECURE: 'true',
      SMTP_USER: 'user',
      SMTP_PASSWORD: 'pass',
    });

    const provider = createEmailProvider(env, {
      // Minimal stub; we only need createTransport and the returned sendMail.
      nodemailer: nodemailerStub as unknown as typeof import('nodemailer'),
    });

    await provider.send({
      to: 'to@example.com',
      from: env.EMAIL_FROM,
      replyTo: env.EMAIL_REPLY_TO,
      subject: 'Subject',
      text: 'Text',
      html: '<p>Text</p>',
    });

    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 2525,
      secure: true,
      auth: { user: 'user', pass: 'pass' },
    });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'noreply@example.com',
      to: 'to@example.com',
      replyTo: 'support@example.com',
      subject: 'Subject',
      text: 'Text',
      html: '<p>Text</p>',
    });
  });
});

