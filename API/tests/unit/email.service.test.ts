import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/config/env.js';
import { createEmailProvider } from '../../src/services/email.service.js';

type SesModule = typeof import('@aws-sdk/client-ses');

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

  it('creates an ses provider that errors when AWS_REGION is missing', async () => {
    const loadSesModule = vi.fn(async () => {
      throw new Error('should not be called');
    });

    const provider = createEmailProvider(
      baseEnv({ EMAIL_PROVIDER: 'ses', EMAIL_FROM: 'noreply@example.com' }),
      { loadSesModule: loadSesModule as unknown as () => Promise<SesModule> },
    );

    await expect(
      provider.send({ to: 't@example.com', from: 'noreply@example.com', subject: 's', text: 'hello' }),
    ).rejects.toThrow(/AWS_REGION/);
    expect(loadSesModule).not.toHaveBeenCalled();
  });

  it('creates a sendgrid provider that errors when SENDGRID_API_KEY is missing', async () => {
    const loadSendgridModule = vi.fn(async () => {
      throw new Error('should not be called');
    });

    const provider = createEmailProvider(
      baseEnv({ EMAIL_PROVIDER: 'sendgrid', EMAIL_FROM: 'noreply@example.com' }),
      { loadSendgridModule: loadSendgridModule as unknown as () => Promise<unknown> },
    );

    await expect(
      provider.send({ to: 't@example.com', from: 'noreply@example.com', subject: 's', text: 'hello' }),
    ).rejects.toThrow(/SENDGRID_API_KEY/);
    expect(loadSendgridModule).not.toHaveBeenCalled();
  });

  it('creates a sendgrid provider that sends mail via dynamic import', async () => {
    const setApiKey = vi.fn();
    const send = vi.fn(async () => [{ statusCode: 202 }, {}]);
    const loadSendgridModule = vi.fn(async () => ({
      default: { setApiKey, send },
    }));

    const env = baseEnv({
      EMAIL_PROVIDER: 'sendgrid',
      SENDGRID_API_KEY: 'SG.example-key',
      EMAIL_FROM: 'noreply@example.com',
      EMAIL_REPLY_TO: 'support@example.com',
    });

    const provider = createEmailProvider(env, {
      loadSendgridModule: loadSendgridModule as unknown as () => Promise<unknown>,
    });

    await provider.send({
      to: 'to@example.com',
      from: env.EMAIL_FROM,
      replyTo: env.EMAIL_REPLY_TO,
      subject: 'Subject',
      text: 'Text',
      html: '<p>Text</p>',
    });
    await provider.send({
      to: 'to2@example.com',
      from: env.EMAIL_FROM,
      subject: 'Subject2',
      text: 'Text2',
    });

    expect(loadSendgridModule).toHaveBeenCalledTimes(1);
    expect(setApiKey).toHaveBeenCalledTimes(1);
    expect(setApiKey).toHaveBeenCalledWith('SG.example-key');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, {
      to: 'to@example.com',
      from: 'noreply@example.com',
      replyTo: 'support@example.com',
      subject: 'Subject',
      text: 'Text',
      html: '<p>Text</p>',
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      to: 'to2@example.com',
      from: 'noreply@example.com',
      replyTo: undefined,
      subject: 'Subject2',
      text: 'Text2',
      html: undefined,
    });
  });

  it('creates an ses provider that sends via AWS SES with dynamic import', async () => {
    class SendEmailCommand {
      readonly input: unknown;

      constructor(input: unknown) {
        this.input = input;
      }
    }

    class SESServiceException extends Error {
      readonly $metadata: { httpStatusCode?: number };

      constructor(name: string, httpStatusCode?: number) {
        super(name);
        this.name = name;
        this.$metadata = { httpStatusCode };
      }
    }

    const send = vi.fn(async () => undefined);
    const SESClient = vi.fn(() => ({ send }));
    const loadSesModule = vi.fn(async () => ({
      SESClient: SESClient as unknown as SesModule['SESClient'],
      SendEmailCommand: SendEmailCommand as unknown as SesModule['SendEmailCommand'],
      SESServiceException: SESServiceException as unknown as SesModule['SESServiceException'],
    }));

    const env = baseEnv({
      EMAIL_PROVIDER: 'ses',
      AWS_REGION: 'eu-west-1',
      EMAIL_FROM: 'noreply@example.com',
      EMAIL_REPLY_TO: 'support@example.com',
    });

    const provider = createEmailProvider(env, { loadSesModule });
    await provider.send({
      to: 'to@example.com',
      from: env.EMAIL_FROM,
      replyTo: env.EMAIL_REPLY_TO,
      subject: 'Subject',
      text: 'Text',
      html: '<p>Text</p>',
    });
    await provider.send({
      to: 'to2@example.com',
      from: env.EMAIL_FROM,
      subject: 'Subject2',
      text: 'Text2',
    });

    expect(loadSesModule).toHaveBeenCalledTimes(1);
    expect(SESClient).toHaveBeenCalledTimes(1);
    expect(SESClient).toHaveBeenCalledWith({ region: 'eu-west-1' });
    expect(send).toHaveBeenCalledTimes(2);

    const firstCommand = send.mock.calls[0]?.[0] as SendEmailCommand;
    expect(firstCommand.input).toEqual({
      Destination: { ToAddresses: ['to@example.com'] },
      Message: {
        Subject: { Data: 'Subject' },
        Body: {
          Text: { Data: 'Text' },
          Html: { Data: '<p>Text</p>' },
        },
      },
      Source: 'noreply@example.com',
      ReplyToAddresses: ['support@example.com'],
    });

    const secondCommand = send.mock.calls[1]?.[0] as SendEmailCommand;
    expect(secondCommand.input).toEqual({
      Destination: { ToAddresses: ['to2@example.com'] },
      Message: {
        Subject: { Data: 'Subject2' },
        Body: {
          Text: { Data: 'Text2' },
        },
      },
      Source: 'noreply@example.com',
      ReplyToAddresses: undefined,
    });
  });

  it('wraps SES service exceptions with safe metadata only', async () => {
    class SendEmailCommand {
      constructor() {}
    }

    class SESServiceException extends Error {
      readonly $metadata: { httpStatusCode?: number };

      constructor(name: string, httpStatusCode?: number) {
        super(name);
        this.name = name;
        this.$metadata = { httpStatusCode };
      }
    }

    const send = vi.fn(async () => {
      throw new SESServiceException('MessageRejected', 400);
    });

    const loadSesModule = vi.fn(async () => ({
      SESClient: vi.fn(() => ({ send })) as unknown as SesModule['SESClient'],
      SendEmailCommand: SendEmailCommand as unknown as SesModule['SendEmailCommand'],
      SESServiceException: SESServiceException as unknown as SesModule['SESServiceException'],
    }));

    const provider = createEmailProvider(
      baseEnv({
        EMAIL_PROVIDER: 'ses',
        AWS_REGION: 'eu-west-1',
        EMAIL_FROM: 'noreply@example.com',
      }),
      { loadSesModule },
    );

    const error = await provider
      .send({
        to: 'to@example.com',
        from: 'noreply@example.com',
        subject: 'Subject',
        text: 'Text',
      })
      .catch((err) => err as Error & { safeContext?: Record<string, unknown> });

    expect(error.name).toBe('ProviderSendError');
    expect(error.safeContext).toEqual({
      providerErrorName: 'MessageRejected',
      providerHttpStatusCode: 400,
    });
  });

  it('wraps SendGrid errors with safe metadata only', async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('bad request'), {
        name: 'ResponseError',
        response: {
          statusCode: 429,
          body: { errors: [{ message: 'The to address is invalid', email: 'to@example.com' }] },
        },
      });
    });

    const loadSendgridModule = vi.fn(async () => ({
      default: {
        setApiKey: vi.fn(),
        send,
      },
    }));

    const provider = createEmailProvider(
      baseEnv({
        EMAIL_PROVIDER: 'sendgrid',
        SENDGRID_API_KEY: 'SG.example-key',
        EMAIL_FROM: 'noreply@example.com',
      }),
      { loadSendgridModule: loadSendgridModule as unknown as () => Promise<unknown> },
    );

    const error = await provider
      .send({
        to: 'to@example.com',
        from: 'noreply@example.com',
        subject: 'Subject',
        text: 'Text',
      })
      .catch((err) => err as Error & { safeContext?: Record<string, unknown> });

    expect(error.name).toBe('ProviderSendError');
    expect(error.safeContext).toEqual({
      providerErrorName: 'ResponseError',
      providerHttpStatusCode: 429,
    });
  });
});
