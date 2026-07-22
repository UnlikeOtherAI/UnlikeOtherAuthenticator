import { randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

import type { ClientConfig } from './config.service.js';

import { EMAIL_TOKEN_TTL_MS } from '../config/constants.js';
import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { buildUserIdentity } from './user-scope.service.js';
import { extractEmailTheme } from './email-theme.service.js';
import {
  sendAccountExistsEmail,
  sendLoginLinkEmail,
  sendVerifyEmailEmail,
  sendVerifyEmailSetPasswordEmail,
} from './email.service.js';
import { extractEmailDomain } from '../utils/email-domain.js';
import { generateEmailToken, hashEmailToken } from '../utils/verification-token.js';
import { isPrincipalBannedForRegistration } from './ban-policy.service.js';

/**
 * Brief 11: Registration must not reveal whether the email exists.
 *
 * Task 4.3 implements the endpoint + constant response behavior.
 * Task 4.4 will implement "email determines next step" (existing -> login link,
 * new -> verification + set password) without changing the public response.
 */
type RegisterPrisma = PrismaClient;

type RegisterDeps = {
  env?: ReturnType<typeof getEnv>;
  now?: () => Date;
  sharedSecret?: string;
  sendAccountExistsEmail?: typeof sendAccountExistsEmail;
  sendLoginLinkEmail?: typeof sendLoginLinkEmail;
  sendVerifyEmailEmail?: typeof sendVerifyEmailEmail;
  sendVerifyEmailSetPasswordEmail?: typeof sendVerifyEmailSetPasswordEmail;
  generateEmailToken?: typeof generateEmailToken;
  hashEmailToken?: typeof hashEmailToken;
  consumeAccountFlowTimingBudget?: () => Promise<void>;
  isPrincipalBannedForRegistration?: typeof isPrincipalBannedForRegistration;
  prisma?: RegisterPrisma;
};

type RegistrationInstructionResult = { status: 'sent' } | { status: 'existing_user' };

/**
 * Brief 11: equalize CPU/IO between the user-exists and user-missing/blocked branches
 * so the response time does not leak account existence or registration eligibility.
 * Argon2id is the heaviest single step in the exists branch (HMAC + token.create +
 * email send) — matching its cost within an order of magnitude is enough. The hash
 * result is discarded; no token persisted and no mail sent.
 */
async function consumeAccountFlowTimingBudget(): Promise<void> {
  try {
    await argon2.hash(randomBytes(16).toString('hex'), {
      type: argon2.argon2id,
      timeCost: 3,
      memoryCost: 2 ** 15,
      parallelism: 1,
      hashLength: 32,
    });
  } catch {
    // Never let a timing-equalisation failure surface as an account-flow error.
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function buildRegistrationEmailLandingLink(params: {
  baseUrl: string;
  token: string;
  configUrl: string;
  redirectUrl?: string;
  requestAccess?: boolean;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
}): string {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  // Neutral landing route for registration flows (existing-user login link vs new-user
  // verify+set-password) to avoid leaking account state via URL semantics.
  const url = new URL(`${baseUrl}/auth/email/link`);
  url.searchParams.set('token', params.token);
  url.searchParams.set('config_url', params.configUrl);
  if (params.redirectUrl) {
    url.searchParams.set('redirect_url', params.redirectUrl);
  }
  if (params.requestAccess) {
    url.searchParams.set('request_access', 'true');
  }
  if (params.codeChallenge) {
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', params.codeChallengeMethod ?? 'S256');
  }
  return url.toString();
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
    redirectUrl?: string;
    requestAccess?: boolean;
    codeChallenge?: string;
    codeChallengeMethod?: 'S256';
    ip?: string | null;
  },
  deps?: RegisterDeps,
): Promise<RegistrationInstructionResult> {
  const env = deps?.env ?? getEnv();

  // Keep API behavior stable in environments where the DB isn't configured yet.
  if (!env.DATABASE_URL) return { status: 'sent' };

  const { userKey, domain, email } = buildUserIdentity({
    userScope: params.config.user_scope,
    email: params.email,
    domain: params.config.domain,
  });

  // Admin ban list (domain scope). A banned email/pattern/IP gets the same silent,
  // timing-equalised response as a blocked registration — never reveal the ban.
  const banned = await (deps?.isPrincipalBannedForRegistration ?? isPrincipalBannedForRegistration)(
    {
      domain: params.config.domain,
      email: params.email,
      ip: params.ip ?? null,
    },
  );
  if (banned) {
    await (deps?.consumeAccountFlowTimingBudget ?? consumeAccountFlowTimingBudget)();
    return { status: 'sent' };
  }

  const prisma = deps?.prisma ?? getPrisma();
  const existing = await prisma.user.findUnique({
    where: { userKey },
    select: { id: true, tokenVersion: true },
  });

  if (existing && params.config.existing_user_registration_behavior === 'inline_sign_in') {
    return { status: 'existing_user' };
  }

  if (
    !existing &&
    !params.requestAccess &&
    !isNewUserEmailRegistrationAllowed({
      email,
      config: params.config,
    })
  ) {
    // Don't leak "registration blocked" vs "registration in progress" via timing.
    await (deps?.consumeAccountFlowTimingBudget ?? consumeAccountFlowTimingBudget)();
    return { status: 'sent' };
  }

  const token = deps?.generateEmailToken ? deps.generateEmailToken() : generateEmailToken();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const tokenHash = deps?.hashEmailToken
    ? deps.hashEmailToken(token, sharedSecret)
    : hashEmailToken(token, sharedSecret);

  const now = deps?.now ? deps.now() : new Date();
  const expiresAt = new Date(now.getTime() + EMAIL_TOKEN_TTL_MS);

  const type = existing
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
      tokenVersion: existing?.tokenVersion ?? null,
    },
  });

  const baseUrl = env.PUBLIC_BASE_URL
    ? normalizeBaseUrl(env.PUBLIC_BASE_URL)
    : `http://${env.HOST}:${env.PORT}`;

  const theme = extractEmailTheme(params.config);

  if (existing) {
    const link = buildRegistrationEmailLandingLink({
      baseUrl,
      token,
      configUrl: params.configUrl,
      redirectUrl: params.redirectUrl,
      requestAccess: params.requestAccess,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
    });
    await (deps?.sendAccountExistsEmail ?? sendAccountExistsEmail)({ to: email, link, theme });
    return { status: 'sent' };
  }

  const link = buildRegistrationEmailLandingLink({
    baseUrl,
    token,
    configUrl: params.configUrl,
    redirectUrl: params.redirectUrl,
    requestAccess: params.requestAccess,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
  });
  if (type === 'VERIFY_EMAIL') {
    await (deps?.sendVerifyEmailEmail ?? sendVerifyEmailEmail)({
      to: email,
      link,
      theme,
    });
    return { status: 'sent' };
  }

  await (deps?.sendVerifyEmailSetPasswordEmail ?? sendVerifyEmailSetPasswordEmail)({
    to: email,
    link,
    theme,
  });
  return { status: 'sent' };
}
