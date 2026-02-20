import nodemailer from 'nodemailer';

import type { Env } from '../config/env.js';
import { getEnv } from '../config/env.js';
import {
  buildLoginLinkTemplate,
  buildPasswordResetTemplate,
  buildTwoFaResetTemplate,
  buildVerifyEmailTemplate,
  buildVerifyEmailSetPasswordTemplate,
} from './email.templates.js';

type SesModule = typeof import('@aws-sdk/client-ses');

export type EmailProviderName = 'disabled' | 'smtp' | 'ses' | 'sendgrid';

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
  replyTo?: string;
};

type EmailProvider = {
  name: EmailProviderName;
  send: (message: EmailMessage) => Promise<void>;
};

type EmailProviderDeps = {
  nodemailer?: typeof nodemailer;
  loadSesModule?: () => Promise<SesModule>;
  loadSendgridModule?: () => Promise<unknown>;
};

class ProviderSendError extends Error {
  readonly safeContext: Record<string, unknown>;

  constructor(message: string, safeContext: Record<string, unknown>) {
    super(message);
    this.name = 'ProviderSendError';
    this.safeContext = safeContext;
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function resolveProviderName(env: Env): EmailProviderName {
  return env.EMAIL_PROVIDER ?? 'disabled';
}

function loadSesModule(): Promise<SesModule> {
  return import('@aws-sdk/client-ses');
}

function loadSendgridModule(): Promise<unknown> {
  return import('@sendgrid/mail');
}

function safeEmailLog(env: Env, message: EmailMessage): void {
  // Email bodies contain bearer links (tokens). Never log them in production.
  if (env.NODE_ENV === 'production') {
    console.info('[email]', { to: message.to, subject: message.subject });
    return;
  }

  if (env.NODE_ENV === 'test') return;

  console.info('[email:dev]', {
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}

function createDisabledProvider(env: Env): EmailProvider {
  return {
    name: 'disabled',
    async send(message) {
      safeEmailLog(env, message);
    },
  };
}

function createSmtpProvider(env: Env, deps?: EmailProviderDeps): EmailProvider {
  const nm = deps?.nodemailer ?? nodemailer;
  const host = env.SMTP_HOST;
  const port = env.SMTP_PORT ?? 587;
  const secure = parseBoolean(env.SMTP_SECURE, false);

  // Don't fail server startup if SMTP is misconfigured; callers handle failures generically.
  if (!host) {
    return {
      name: 'smtp',
      async send() {
        throw new Error('SMTP_HOST is required when EMAIL_PROVIDER=smtp');
      },
    };
  }

  const transporter = nm.createTransport({
    host,
    port,
    secure,
    auth: env.SMTP_USER && env.SMTP_PASSWORD ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });

  return {
    name: 'smtp',
    async send(message) {
      if (!message.from) {
        throw new Error('EMAIL_FROM is required when EMAIL_PROVIDER=smtp');
      }
      await transporter.sendMail({
        from: message.from,
        to: message.to,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
  };
}

function createSesProvider(env: Env, deps?: EmailProviderDeps): EmailProvider {
  const region = env.AWS_REGION;

  // Don't fail server startup if SES is misconfigured; callers handle failures generically.
  if (!region) {
    return {
      name: 'ses',
      async send() {
        throw new Error('AWS_REGION is required when EMAIL_PROVIDER=ses');
      },
    };
  }

  type SesRuntime = {
    mod: SesModule;
    client: InstanceType<SesModule['SESClient']>;
  };

  const loadSes = deps?.loadSesModule ?? loadSesModule;
  let runtimePromise: Promise<SesRuntime> | undefined;

  const getRuntime = async (): Promise<SesRuntime> => {
    if (!runtimePromise) {
      runtimePromise = (async () => {
        const mod = await loadSes();
        return {
          mod,
          client: new mod.SESClient({ region }),
        };
      })();
    }
    return runtimePromise;
  };

  return {
    name: 'ses',
    async send(message) {
      if (!message.from) {
        throw new Error('EMAIL_FROM is required when EMAIL_PROVIDER=ses');
      }

      const runtime = await getRuntime();
      const { SendEmailCommand, SESServiceException } = runtime.mod;
      const body: { Text: { Data: string }; Html?: { Data: string } } = {
        Text: { Data: message.text },
      };

      if (message.html) {
        body.Html = { Data: message.html };
      }

      try {
        await runtime.client.send(
          new SendEmailCommand({
            Destination: { ToAddresses: [message.to] },
            Message: {
              Subject: { Data: message.subject },
              Body: body,
            },
            Source: message.from,
            ReplyToAddresses: message.replyTo ? [message.replyTo] : undefined,
          }),
        );
      } catch (err) {
        if (err instanceof SESServiceException) {
          throw new ProviderSendError('SES send failed', {
            providerErrorName: err.name,
            providerHttpStatusCode: err.$metadata?.httpStatusCode,
          });
        }

        throw err;
      }
    },
  };
}

type SendgridClient = {
  setApiKey: (apiKey: string) => void;
  send: (message: {
    to: string;
    from: string;
    replyTo?: string;
    subject: string;
    text: string;
    html?: string;
  }) => Promise<unknown>;
};

function resolveSendgridClient(mod: unknown): SendgridClient {
  const client = ((mod as { default?: unknown }).default ?? mod) as SendgridClient;
  if (typeof client?.setApiKey !== 'function' || typeof client?.send !== 'function') {
    throw new Error('Invalid @sendgrid/mail module shape');
  }
  return client;
}

function extractProviderHttpStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }

  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number') {
    return code;
  }

  const responseStatusCode = (err as { response?: { statusCode?: unknown } }).response?.statusCode;
  if (typeof responseStatusCode === 'number') {
    return responseStatusCode;
  }

  return undefined;
}

function createSendgridProvider(env: Env, deps?: EmailProviderDeps): EmailProvider {
  const apiKey = env.SENDGRID_API_KEY;

  // Don't fail server startup if SendGrid is misconfigured; callers handle failures generically.
  if (!apiKey) {
    return {
      name: 'sendgrid',
      async send() {
        throw new Error('SENDGRID_API_KEY is required when EMAIL_PROVIDER=sendgrid');
      },
    };
  }

  const loadSendgrid = deps?.loadSendgridModule ?? loadSendgridModule;
  let clientPromise: Promise<SendgridClient> | undefined;

  const getClient = async (): Promise<SendgridClient> => {
    if (!clientPromise) {
      clientPromise = (async () => {
        const mod = await loadSendgrid();
        const client = resolveSendgridClient(mod);
        client.setApiKey(apiKey);
        return client;
      })();
    }

    return clientPromise;
  };

  return {
    name: 'sendgrid',
    async send(message) {
      if (!message.from) {
        throw new Error('EMAIL_FROM is required when EMAIL_PROVIDER=sendgrid');
      }

      const client = await getClient();

      try {
        await client.send({
          to: message.to,
          from: message.from,
          replyTo: message.replyTo,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
      } catch (err) {
        throw new ProviderSendError('SendGrid send failed', {
          providerErrorName: err instanceof Error ? err.name : 'UnknownError',
          providerHttpStatusCode: extractProviderHttpStatusCode(err),
        });
      }
    },
  };
}

function toSafeErrorContext(err: unknown): Record<string, unknown> {
  if (err instanceof ProviderSendError) {
    return err.safeContext;
  }

  if (err instanceof Error) {
    return { providerErrorName: err.name };
  }

  return { providerErrorName: 'UnknownError' };
}

export function createEmailProvider(env: Env, deps?: EmailProviderDeps): EmailProvider {
  const name = resolveProviderName(env);
  switch (name) {
    case 'smtp':
      return createSmtpProvider(env, deps);
    case 'ses':
      return createSesProvider(env, deps);
    case 'sendgrid':
      return createSendgridProvider(env, deps);
    case 'disabled':
      return createDisabledProvider(env);
    default:
      throw new Error(`Unsupported EMAIL_PROVIDER: ${name}`);
  }
}

let cachedProvider: EmailProvider | undefined;

export function resetEmailProviderCache(): void {
  cachedProvider = undefined;
}

function getProvider(): EmailProvider {
  cachedProvider ??= createEmailProvider(getEnv());
  return cachedProvider;
}

async function dispatchEmail(message: EmailMessage): Promise<void> {
  const env = getEnv();
  const provider = getProvider();

  try {
    await provider.send(message);
  } catch (err) {
    // Brief 11 / 13: never leak specifics. Email sending failures should not reveal anything to users.
    // Avoid logging bearer links/tokens; include only minimal metadata.
    console.error('[email:error]', {
      provider: provider.name,
      to: message.to,
      subject: message.subject,
      ...toSafeErrorContext(err),
    });

    // Keep API behavior stable (especially registration) even if email fails.
    // The caller should still respond with a generic message.
    if (env.NODE_ENV !== 'production') {
      safeEmailLog(env, message);
    }
  }
}

export async function sendLoginLinkEmail(params: { to: string; link: string }): Promise<void> {
  const env = getEnv();
  const template = buildLoginLinkTemplate({ link: params.link });
  await dispatchEmail({
    to: params.to,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });
}

export async function sendVerifyEmailSetPasswordEmail(params: {
  to: string;
  link: string;
}): Promise<void> {
  const env = getEnv();
  const template = buildVerifyEmailSetPasswordTemplate({ link: params.link });
  await dispatchEmail({
    to: params.to,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });
}

export async function sendVerifyEmailEmail(params: { to: string; link: string }): Promise<void> {
  const env = getEnv();
  const template = buildVerifyEmailTemplate({ link: params.link });
  await dispatchEmail({
    to: params.to,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });
}

export async function sendPasswordResetEmail(params: { to: string; link: string }): Promise<void> {
  const env = getEnv();
  const template = buildPasswordResetTemplate({ link: params.link });
  await dispatchEmail({
    to: params.to,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });
}

export async function sendTwoFaResetEmail(params: { to: string; link: string }): Promise<void> {
  const env = getEnv();
  const template = buildTwoFaResetTemplate({ link: params.link });
  await dispatchEmail({
    to: params.to,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });
}
