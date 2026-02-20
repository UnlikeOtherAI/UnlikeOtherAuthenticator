import type { ClientConfig } from './config.service.js';

import { EMAIL_TOKEN_TTL_MS } from '../config/constants.js';
import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { buildUserIdentity } from './user-scope.service.js';
import {
  sendLoginLinkEmail,
  sendVerifyEmailEmail,
  sendVerifyEmailSetPasswordEmail,
} from './email.service.js';
import { generateEmailToken, hashEmailToken } from '../utils/verification-token.js';

/**
 * Brief 11: Registration must not reveal whether the email exists.
 *
 * Task 4.3 implements the endpoint + constant response behavior.
 * Task 4.4 will implement "email determines next step" (existing -> login link,
 * new -> verification + set password) without changing the public response.
 */
type RegisterPrisma = {
  user: {
    findUnique: (args: {
      where: { userKey: string };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
  verificationToken: {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
};

type RegisterDeps = {
  env?: ReturnType<typeof getEnv>;
  now?: () => Date;
  sharedSecret?: string;
  sendLoginLinkEmail?: typeof sendLoginLinkEmail;
  sendVerifyEmailEmail?: typeof sendVerifyEmailEmail;
  sendVerifyEmailSetPasswordEmail?: typeof sendVerifyEmailSetPasswordEmail;
  generateEmailToken?: typeof generateEmailToken;
  hashEmailToken?: typeof hashEmailToken;
  prisma?: RegisterPrisma;
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function buildRegistrationEmailLandingLink(params: {
  baseUrl: string;
  token: string;
  configUrl: string;
}): string {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  // Neutral landing route for registration flows (existing-user login link vs new-user
  // verify+set-password) to avoid leaking account state via URL semantics.
  const url = new URL(`${baseUrl}/auth/email/link`);
  url.searchParams.set('token', params.token);
  url.searchParams.set('config_url', params.configUrl);
  return url.toString();
}

function extractEmailDomain(email: string): string | null {
  const atIndex = email.lastIndexOf('@');
  if (atIndex < 0 || atIndex === email.length - 1) return null;
  return email.slice(atIndex + 1).toLowerCase();
}

function isNewUserEmailRegistrationAllowed(params: {
  email: string;
  config: ClientConfig;
}): boolean {
  if (params.config.allow_registration === false) {
    return false;
  }

  const domains = params.config.allowed_registration_domains;
  if (!domains?.length) {
    return true;
  }

  const emailDomain = extractEmailDomain(params.email);
  if (!emailDomain) {
    return false;
  }

  return domains.includes(emailDomain);
}

export async function requestRegistrationInstructions(
  params: {
    email: string;
    config: ClientConfig;
    configUrl: string;
  },
  deps?: RegisterDeps,
): Promise<void> {
  const env = deps?.env ?? getEnv();

  // Keep API behavior stable in environments where the DB isn't configured yet.
  if (!env.DATABASE_URL) return;

  const { userKey, domain, email } = buildUserIdentity({
    userScope: params.config.user_scope,
    email: params.email,
    domain: params.config.domain,
  });

  const prisma = deps?.prisma ?? getPrisma();
  const existing = await prisma.user.findUnique({
    where: { userKey },
    select: { id: true },
  });

  if (
    !existing &&
    !isNewUserEmailRegistrationAllowed({
      email,
      config: params.config,
    })
  ) {
    return;
  }

  const token = deps?.generateEmailToken ? deps.generateEmailToken() : generateEmailToken();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const tokenHash = deps?.hashEmailToken
    ? deps.hashEmailToken(token, sharedSecret)
    : hashEmailToken(token, sharedSecret);

  const now = deps?.now ? deps.now() : new Date();
  const expiresAt = new Date(now.getTime() + EMAIL_TOKEN_TTL_MS);

  const type =
    existing
      ? 'LOGIN_LINK'
      : params.config.registration_mode === 'passwordless'
        ? 'VERIFY_EMAIL'
        : 'VERIFY_EMAIL_SET_PASSWORD';
  await prisma.verificationToken.create({
    data: {
      type,
      email,
      userKey,
      domain,
      configUrl: params.configUrl,
      tokenHash,
      expiresAt,
      userId: existing?.id ?? null,
    },
  });

  const baseUrl = env.PUBLIC_BASE_URL
    ? normalizeBaseUrl(env.PUBLIC_BASE_URL)
    : `http://${env.HOST}:${env.PORT}`;

  if (existing) {
    const link = buildRegistrationEmailLandingLink({
      baseUrl,
      token,
      configUrl: params.configUrl,
    });
    await (deps?.sendLoginLinkEmail ?? sendLoginLinkEmail)({ to: email, link });
    return;
  }

  const link = buildRegistrationEmailLandingLink({
    baseUrl,
    token,
    configUrl: params.configUrl,
  });
  if (type === 'VERIFY_EMAIL') {
    await (deps?.sendVerifyEmailEmail ?? sendVerifyEmailEmail)({
      to: email,
      link,
    });
    return;
  }

  await (deps?.sendVerifyEmailSetPasswordEmail ?? sendVerifyEmailSetPasswordEmail)({
    to: email,
    link,
  });
}
