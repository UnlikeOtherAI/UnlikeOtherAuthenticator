import { randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { parseRequiredPkceChallenge } from '../utils/pkce.js';
import type { ClientConfig } from './config.service.js';
import { fingerprintClientConfig } from './client-config-fingerprint.service.js';
import { hashAssuranceReference } from './session-assurance.service.js';
import { buildUserIdentity } from './user-scope.service.js';
import { selectRedirectUrl } from './authorization-code.service.js';
import { resolveProductTeamPolicy } from './product-team-policy.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import { lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import { verifyTwoFactorForLogin } from './twofactor-login.service.js';
import { recordIndependentAuthentication } from './authentication-evidence.service.js';
import { createManagementIntent, finishManagementIntent } from './org-sso-management-intent.service.js';

const Context = z.object({ redirect_url: z.string().min(1).max(2048), state: z.string().max(2048).optional(),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256') }).strict();
type Scope = { config: ClientConfig; configUrl: string };
function failed(): never { throw new AppError('FORBIDDEN', 403, 'SSO_MANAGEMENT_REAUTH_REQUIRED'); }
async function destination(config: ClientConfig, orgId: string, tx: Prisma.TransactionClient) {
  const [org, client, reach] = await Promise.all([
    tx.organisation.findUnique({ where: { id: orgId }, select: { id: true, name: true, domain: true, ownerId: true, lifecycleStatus: true } }),
    tx.clientDomain.findUnique({ where: { domain: config.domain }, select: { status: true } }),
    resolveProductTeamPolicy({ domain: config.domain }, { prisma: tx }),
  ]);
  if (!org || org.lifecycleStatus !== 'ACTIVE' || client?.status !== 'active' ||
    (org.domain !== config.domain && reach.scope !== 'all_active_memberships')) failed();
  return org;
}

/** Email is a lookup hint; every caller receives the same opaque challenge and public destination. */
export async function startManagementPersonalFactor(input: Scope & { orgId: string; email: string; redirectUrl?: string;
  codeChallenge: string; codeChallengeMethod: 'S256'; state?: string }, db: PrismaClient = getAdminPrisma()) {
  const redirect = selectRedirectUrl({ allowedRedirectUrls: input.config.redirect_urls, requestedRedirectUrl: input.redirectUrl });
  const pkce = parseRequiredPkceChallenge({ codeChallenge: input.codeChallenge, codeChallengeMethod: input.codeChallengeMethod });
  const context = Context.parse({ redirect_url: redirect, code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256', state: input.state });
  const browser = randomBytes(32).toString('base64url'); const token = randomBytes(32).toString('base64url');
  return db.$transaction(async tx => {
    await lockProductTeamPolicyShared(tx); const org = await destination(input.config, input.orgId, tx);
    const key = buildUserIdentity({ userScope: input.config.user_scope, email: input.email, domain: input.config.domain });
    const user = await tx.user.findUnique({ where: { userKey: key.userKey },
      select: { id: true, tokenVersion: true, lifecycleStatus: true, twoFaEnabled: true, twoFaSecret: true } });
    const eligible = user?.id === org.ownerId && user.lifecycleStatus === 'ACTIVE' && user.twoFaEnabled && user.twoFaSecret ? user : null;
    const expiresAt = new Date(Date.now() + 300000);
    await tx.orgSsoManagementFactorChallenge.create({ data: { tokenHash: hashAssuranceReference(token),
      browserHash: hashAssuranceReference(browser), clientDomain: input.config.domain, orgId: org.id,
      userId: eligible?.id, credentialEpoch: eligible?.tokenVersion,
      factorHash: eligible?.twoFaSecret ? hashAssuranceReference(eligible.twoFaSecret) : null,
      configUrl: input.configUrl, configFingerprint: fingerprintClientConfig(input.config), context, expiresAt } });
    return { browser, response: { ok: true, personal_factor_required: true, challenge: token,
      expires_at: expiresAt.toISOString(), org: { id: org.id, name: org.name }, client_domain: input.config.domain } };
  });
}

/** An old personal factor mints only exact owner management continuation, never a product/global session. */
export async function verifyManagementPersonalFactor(input: Scope & { challenge: string; code: string; browser?: string },
  db: PrismaClient = getAdminPrisma()) {
  const result = await db.$transaction(async tx => {
    await lockProductTeamPolicyShared(tx);
    const row = await tx.orgSsoManagementFactorChallenge.findUnique({ where: { tokenHash: hashAssuranceReference(input.challenge) } });
    if (!row || !input.browser || row.browserHash !== hashAssuranceReference(input.browser) || row.consumedAt ||
      row.expiresAt <= new Date() || row.clientDomain !== input.config.domain || row.configUrl !== input.configUrl ||
      row.configFingerprint !== fingerprintClientConfig(input.config)) return null;
    let epochValid = true;
    if (row.userId && row.credentialEpoch !== null) {
      try { await lockAndAssertAuthenticationEpoch({ userId: row.userId, domain: row.clientDomain,
        credentialEpoch: row.credentialEpoch }, { prisma: tx }); }
      catch (error) { if (error instanceof AppError && error.statusCode < 500) epochValid = false; else throw error; }
    }
    // Fixed binding is immutable. This CAS commits failed guesses, including ineligible hints.
    const attempt = await tx.orgSsoManagementFactorChallenge.updateMany({ where: { id: row.id, consumedAt: null,
      attempts: { lt: 6 }, expiresAt: { gt: new Date() } }, data: { attempts: { increment: 1 } } });
    if (attempt.count !== 1 || !epochValid || !row.userId || row.credentialEpoch === null || !/^\d{6}$/.test(input.code)) return null;
    try {
      const org = await destination(input.config, row.orgId, tx);
      const user = await tx.user.findUnique({ where: { id: row.userId }, select: { twoFaEnabled: true, twoFaSecret: true } });
      if (org.ownerId !== row.userId || !user?.twoFaEnabled || !user.twoFaSecret ||
        row.factorHash !== hashAssuranceReference(user.twoFaSecret)) return null;
      await verifyTwoFactorForLogin({ userId: row.userId, code: input.code }, { prisma: tx });
      const context = Context.parse(row.context);
      const evidence = await recordIndependentAuthentication({ userId: row.userId, credentialEpoch: row.credentialEpoch,
        method: 'personal_totp', verifiedEvent: { kind: 'local_credential' }, config: input.config,
        configUrl: input.configUrl, redirectUrl: context.redirect_url, codeChallenge: context.code_challenge }, tx);
      await tx.authenticationEvidence.update({ where: { id: evidence }, data: { mfaCompletedAt: new Date(), signatureCompletedAt: new Date() } });
      const intent = await createManagementIntent({ userId: row.userId, credentialEpoch: row.credentialEpoch,
        clientDomain: row.clientDomain, orgId: row.orgId, authenticationEvidenceId: evidence, browser: input.browser }, tx);
      const finished = await finishManagementIntent({ id: intent.id, userId: row.userId, credentialEpoch: row.credentialEpoch,
        clientDomain: row.clientDomain, authenticationEvidenceId: evidence, twoFaCompleted: true }, tx);
      await tx.orgSsoManagementFactorChallenge.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
      return { browser: input.browser, redirectTo: finished.redirectTo };
    } catch (error) {
      if (error instanceof AppError && error.statusCode < 500) return null;
      throw error;
    }
  });
  if (!result) failed(); return result;
}
