import { getEnv } from '../config/env.js';
import type { EmailTheme } from './email.templates.js';
import {
  buildAccessRequestNotificationTemplate,
  buildAccountExistsTemplate,
  buildIntegrationApprovedTemplate,
  buildIntegrationRequestNotificationTemplate,
  buildLoginLinkTemplate,
  buildPasswordResetTemplate,
  buildTeamInviteTemplate,
  buildTwoFaResetTemplate,
  buildVerifyEmailTemplate,
  buildVerifyEmailSetPasswordTemplate,
} from './email.templates.js';
import {
  createEmailProvider,
  safeEmailLog,
  toSafeErrorContext,
  type EmailMessage,
  type EmailProvider,
} from './email.providers.js';
import { getAppLogger } from '../utils/app-logger.js';

export {
  createEmailProvider,
  type EmailMessage,
  type EmailProvider,
  type EmailProviderName,
} from './email.providers.js';

let cachedProvider: EmailProvider | undefined;

export function resetEmailProviderCache(): void {
  cachedProvider = undefined;
}

function getProvider(): EmailProvider {
  cachedProvider ??= createEmailProvider(getEnv());
  return cachedProvider;
}

async function dispatchEmail(message: EmailMessage, options?: { swallowFailures?: boolean }): Promise<void> {
  const env = getEnv();
  const provider = getProvider();

  try {
    await provider.send(message);
  } catch (err) {
    // Brief 11 / 13: never leak specifics. Email sending failures should not reveal anything to users.
    // Avoid logging bearer links/tokens; include only minimal metadata.
    getAppLogger().error(
      {
        provider: provider.name,
        to: message.to,
        subject: message.subject,
        ...toSafeErrorContext(err),
      },
      'email dispatch failed',
    );

    // Keep API behavior stable (especially registration) even if email fails.
    // The caller should still respond with a generic message.
    if (env.NODE_ENV !== 'production') {
      safeEmailLog(env, message);
    }
    if (options?.swallowFailures === false) {
      throw new Error('EMAIL_DISPATCH_FAILED');
    }
  }
}

export async function sendLoginLinkEmail(params: {
  to: string;
  link: string;
  theme?: Partial<EmailTheme>;
}): Promise<void> {
  const env = getEnv();
  const template = buildLoginLinkTemplate({ link: params.link, theme: params.theme });
  await dispatchEmail({
    to: params.to,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });
}

export async function sendTeamInviteEmail(params: {
  to: string;
  link: string;
  organisationName: string;
  teamName: string;
  inviteeName?: string;
  trackingPixelUrl?: string;
  theme?: Partial<EmailTheme>;
}): Promise<void> {
  const env = getEnv();
  const template = buildTeamInviteTemplate({
    link: params.link,
    organisationName: params.organisationName,
    teamName: params.teamName,
    inviteeName: params.inviteeName,
    trackingPixelUrl: params.trackingPixelUrl,
    theme: params.theme,
  });
  await dispatchEmail({
    to: params.to,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });
}

export async function sendAccessRequestNotificationEmail(params: {
  to: string;
  reviewUrl: string;
  requesterEmail: string;
  requesterName?: string | null;
  organisationName: string;
  teamName: string;
  theme?: Partial<EmailTheme>;
}): Promise<void> {
  const env = getEnv();
  const template = buildAccessRequestNotificationTemplate(params);
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
  theme?: Partial<EmailTheme>;
}): Promise<void> {
  const env = getEnv();
  const template = buildVerifyEmailSetPasswordTemplate({ link: params.link, theme: params.theme });
  await dispatchEmail({
    to: params.to,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });
}

export async function sendVerifyEmailEmail(params: {
  to: string;
  link: string;
  theme?: Partial<EmailTheme>;
}): Promise<void> {
  const env = getEnv();
  const template = buildVerifyEmailTemplate({ link: params.link, theme: params.theme });
  await dispatchEmail({
    to: params.to,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });
}

export async function sendAccountExistsEmail(params: {
  to: string;
  link: string;
  theme?: Partial<EmailTheme>;
}): Promise<void> {
  const env = getEnv();
  const template = buildAccountExistsTemplate({ link: params.link, theme: params.theme });
  await dispatchEmail({
    to: params.to,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });
}

export async function sendPasswordResetEmail(params: {
  to: string;
  link: string;
  theme?: Partial<EmailTheme>;
}): Promise<void> {
  const env = getEnv();
  const template = buildPasswordResetTemplate({ link: params.link, theme: params.theme });
  await dispatchEmail({
    to: params.to,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });
}

export async function sendIntegrationApprovedEmail(params: {
  to: string;
  link: string;
  domain: string;
  ttlHours?: number;
  theme?: Partial<EmailTheme>;
}): Promise<void> {
  const env = getEnv();
  const template = buildIntegrationApprovedTemplate({
    link: params.link,
    domain: params.domain,
    ttlHours: params.ttlHours,
    theme: params.theme,
  });
  await dispatchEmail({
    to: params.to,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });
}

export async function sendIntegrationRequestNotificationEmail(params: {
  to: string;
  domain: string;
  contactEmail: string;
  adminUrl: string;
  theme?: Partial<EmailTheme>;
}): Promise<void> {
  const env = getEnv();
  const template = buildIntegrationRequestNotificationTemplate({
    domain: params.domain,
    contactEmail: params.contactEmail,
    adminUrl: params.adminUrl,
    theme: params.theme,
  });
  await dispatchEmail({
    to: params.to,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });
}

export async function sendTwoFaResetEmail(params: {
  to: string;
  link: string;
  theme?: Partial<EmailTheme>;
}): Promise<void> {
  const env = getEnv();
  const template = buildTwoFaResetTemplate({ link: params.link, theme: params.theme });
  await dispatchEmail({
    to: params.to,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });
}

export async function sendRawEmail(params: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from: string;
  fromName?: string | null;
  replyTo?: string | null;
}): Promise<void> {
  const env = getEnv();
  const from = params.fromName?.trim()
    ? `"${params.fromName.trim().replace(/"/g, '\\"')}" <${params.from}>`
    : params.from;

  await dispatchEmail({
    to: params.to,
    from,
    replyTo: params.replyTo ?? env.EMAIL_REPLY_TO,
    subject: params.subject,
    text: params.text,
    html: params.html,
  }, { swallowFailures: false });
}
