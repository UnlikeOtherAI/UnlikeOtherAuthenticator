import { randomUUID } from 'node:crypto';

import type { PendingRegistration, PrismaClient } from '@prisma/client';

import { getPublicBaseUrl } from '../config/env.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { hashEmailToken } from '../utils/verification-token.js';
import { requireEnv } from '../config/env.js';
import { requestRegistrationInstructions, type RegistrationDelivery } from './auth-register.service.js';
import { recordAuthFunnelStep } from './auth-funnel.service.js';
import { fingerprintClientConfig } from './client-config-fingerprint.service.js';
import type { ClientConfig } from './config.service.js';
import { readVerificationTokenEpoch } from './verification-token-epoch.service.js';
import {
  completionToken, equalRegistrationDigest, registrationCode, registrationCookieName,
  registrationDigest, registrationSecret, REGISTRATION_MAX_ATTEMPTS, REGISTRATION_TTL_MS,
} from './registration-credentials.js';
import { publishRegistrationChange } from './registration-events.service.js';

export type RegistrationContext = {
  config: ClientConfig;
  configUrl: string;
  redirectUrl?: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  state?: string;
  requestAccess?: boolean;
};

function contextHash(context: RegistrationContext): string {
  return registrationDigest('context', JSON.stringify([
    context.configUrl, fingerprintClientConfig(context.config), context.redirectUrl ?? null,
    context.codeChallenge ?? null, context.codeChallengeMethod ?? null,
    context.state ?? null, context.requestAccess === true,
  ]));
}

function refuse(): never {
  throw new AppError('BAD_REQUEST', 400, 'REGISTRATION_UNAVAILABLE');
}

function assertBrowser(row: PendingRegistration | null, credential: string, context: RegistrationContext): asserts row is PendingRegistration {
  if (!row || !credential || !equalRegistrationDigest(registrationDigest('browser', credential), row.credentialHash) ||
    !equalRegistrationDigest(contextHash(context), row.contextHash)) refuse();
}

export async function startPendingRegistration(params: RegistrationContext & { email: string | null; ip?: string }, prisma: PrismaClient) {
  const id = randomUUID();
  const credential = registrationSecret();
  const linkToken = registrationSecret();
  const code = registrationCode();
  const expiresAt = new Date(Date.now() + REGISTRATION_TTL_MS);
  const token = completionToken(id, credential);
  await prisma.pendingRegistration.create({ data: {
    id, domain: params.config.domain, credentialHash: registrationDigest('browser', credential),
    linkHash: registrationDigest('link', linkToken), codeHash: registrationDigest('code', `${id}:${code}`),
    completionHash: hashEmailToken(token, requireEnv('SHARED_SECRET').SHARED_SECRET),
    contextHash: contextHash(params), expiresAt,
  } });
  let status: 'sent' | 'existing_user' = 'sent';
  let delivery: RegistrationDelivery | undefined;
  if (params.email) {
    const link = new URL('/auth/registration/link', getPublicBaseUrl());
    // Fragment credentials never enter HTTP access logs or referrers. The isolated
    // landing page removes the fragment before presenting its confirmation action.
    link.hash = linkToken;
    const result = await requestRegistrationInstructions({
      ...params, email: params.email,
      browserRegistration: { completionToken: token, code, link: link.toString(), expiresAt },
    }, { prisma });
    status = result.status;
    if (result.status === 'sent') delivery = result.delivery;
  }
  return { id, credential, expiresAt, status, delivery };
}

export async function pendingRegistrationState(params: RegistrationContext & { id: string; credential: string }, prisma: PrismaClient) {
  const row = await prisma.pendingRegistration.findUnique({ where: { id: params.id } });
  assertBrowser(row, params.credential, params);
  if (row.expiresAt.getTime() <= Date.now() || row.attempts >= REGISTRATION_MAX_ATTEMPTS) {
    return { status: 'expired' as const };
  }
  if (!row.browserAuthorizedAt) return { status: row.emailVerifiedAt ? 'verified' as const : 'pending' as const };
  const tokenRow = await prisma.verificationToken.findUnique({ where: { tokenHash: row.completionHash } });
  if (!tokenRow || tokenRow.expiresAt.getTime() <= Date.now()) return { status: 'expired' as const };
  if (tokenRow.usedAt) return { status: 'complete' as const };
  if (!(await readVerificationTokenEpoch(prisma, tokenRow))) return { status: 'expired' as const };
  return { status: 'authorized' as const, token: completionToken(row.id, params.credential), token_type: tokenRow.type };
}

async function lockRegistration(prisma: PrismaClient, id: string) {
  await prisma.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('pending-registration'), hashtext(${id}))::text AS "lockResult"`;
  return prisma.pendingRegistration.findUnique({ where: { id } });
}

export async function verifyPendingRegistrationCode(params: RegistrationContext & { id: string; credential: string; code: string }, prisma: PrismaClient): Promise<void> {
  const accepted = await runInTransaction(prisma, async tx => {
    const row = await lockRegistration(tx, params.id);
    assertBrowser(row, params.credential, params);
    const now = new Date();
    if (row.expiresAt <= now || row.attempts >= REGISTRATION_MAX_ATTEMPTS) return false;
    if (row.browserAuthorizedAt) return true;
    if (!equalRegistrationDigest(registrationDigest('code', `${row.id}:${params.code}`), row.codeHash)) {
      await tx.pendingRegistration.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      return false; // Commit failed guesses before the public error is thrown.
    }
    await tx.pendingRegistration.update({ where: { id: row.id }, data: {
      emailVerifiedAt: row.emailVerifiedAt ?? now, browserAuthorizedAt: now, linkUsedAt: row.linkUsedAt ?? now,
    } });
    return true;
  });
  if (!accepted) refuse();
  publishRegistrationChange(params.id);
}

export async function verifyPendingRegistrationLink(token: string, cookies: Record<string, string | undefined>, prisma: PrismaClient): Promise<void> {
  const initial = await prisma.pendingRegistration.findUnique({ where: { linkHash: registrationDigest('link', token) } });
  if (!initial) refuse();
  await runInTransaction(prisma, async tx => {
    const row = await lockRegistration(tx, initial.id);
    const now = new Date();
    if (!row || row.expiresAt <= now || row.attempts >= REGISTRATION_MAX_ATTEMPTS) refuse();
    // Replay can display success, but cannot authorize a different browser later.
    if (row.linkUsedAt) return;
    const credential = cookies[registrationCookieName(row.id)];
    const sameBrowser = credential && equalRegistrationDigest(registrationDigest('browser', credential), row.credentialHash);
    await tx.pendingRegistration.update({ where: { id: row.id }, data: {
      emailVerifiedAt: row.emailVerifiedAt ?? now, linkUsedAt: now,
      ...(sameBrowser ? { browserAuthorizedAt: now } : {}),
    } });
  });
  publishRegistrationChange(initial.id);
  await recordAuthFunnelStep({ domain: initial.domain, step: 'email_link_opened', outcome: initial.linkUsedAt
    ? 'already_used' : 'registration_verified' }, { prisma });
}

/** The existing completion endpoint remains the single account/session writer. */
export async function assertPendingRegistrationCompletion(params: RegistrationContext & { token: string; cookies: Record<string, string | undefined> }, prisma: PrismaClient): Promise<void> {
  if (!params.token.startsWith('registration.')) return;
  const row = await prisma.pendingRegistration.findUnique({ where: {
    completionHash: hashEmailToken(params.token, requireEnv('SHARED_SECRET').SHARED_SECRET),
  } });
  if (!row) refuse();
  assertBrowser(row, params.cookies[registrationCookieName(row.id)] ?? '', params);
  if (!row.browserAuthorizedAt || row.expiresAt.getTime() <= Date.now()) refuse();
}
