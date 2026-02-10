import nodemailer from 'nodemailer';

import type { Env } from '../config/env.js';
import { getEnv } from '../config/env.js';
import {
  buildLoginLinkTemplate,
  buildPasswordResetTemplate,
  buildVerifyEmailSetPasswordTemplate,
} from './email.templates.js';

export type EmailProviderName = 'disabled' | 'smtp';

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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function resolveProviderName(env: Env): EmailProviderName {
  return env.EMAIL_PROVIDER ?? 'disabled';
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

function createSmtpProvider(env: Env, deps?: { nodemailer?: typeof nodemailer }): EmailProvider {
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

export function createEmailProvider(env: Env, deps?: { nodemailer?: typeof nodemailer }): EmailProvider {
  const name = resolveProviderName(env);
  switch (name) {
    case 'smtp':
      return createSmtpProvider(env, deps);
    case 'disabled':
    default:
      return createDisabledProvider(env);
  }
}

let cachedProvider: EmailProvider | undefined;

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
      err,
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
  await dispatchEmail({
    to: params.to,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
    subject: 'Reset two-factor authentication',
    text: `Use this link to reset two-factor authentication: ${params.link}\n\nIf you did not request this, you can ignore this email.`,
  });
}
