import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { requireEnv } from '../config/env.js';
import { LOGIN_SESSION_AUDIENCE } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import { requireEnterpriseLink, completeEnterpriseLink } from './org-sso-account-link.service.js';
import { hashAssuranceReference } from './session-assurance.service.js';
import { recordIndependentAuthentication, requireAuthenticationEvidence } from './authentication-evidence.service.js';
import { buildUserIdentity } from './user-scope.service.js';
import { verifyTwoFactorForLogin } from './twofactor-login.service.js';
import { verifyLoginSession } from './login-session.service.js';
import { consumeLoginSession } from './login-session-use.service.js';
import { lockEnterpriseOutbox } from './org-sso-revocation.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import { lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';

type LinkInput = { linkIntentId: string; browser?: string; config: ClientConfig; configUrl: string; ip?: string };
function denied(): never { throw new AppError('UNAUTHORIZED', 401, 'SSO_ACCOUNT_LINK_PROOF_REQUIRED'); }
async function createChallenge(input: LinkInput, principal: { id: string; tokenVersion: number } | null,
  authenticationEvidenceId: string | null, tx: Prisma.TransactionClient) {
  const { link } = await requireEnterpriseLink(input, tx);
  const challenge = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Math.min(Date.now() + 300000, link.expiresAt.getTime()));
  await tx.orgSsoPersonalFactorChallenge.create({ data: { tokenHash: hashAssuranceReference(challenge),
    linkIntentId: link.id, browserHash: link.browserHash, userId: principal?.id,
    credentialEpoch: principal?.tokenVersion, authenticationEvidenceId, expiresAt } });
  return { ok: true, personal_factor_required: true, challenge, expires_at: expiresAt.toISOString() };
}

/** Hints never prove an account or disclose its canonical subject/epoch in a JWT. */
export async function startLinkPersonalFactor(input: LinkInput & { email: string }) {
  return getAdminPrisma().$transaction(async (tx) => {
    await requireEnterpriseLink(input, tx);
    const identity = buildUserIdentity({ userScope: input.config.user_scope, email: input.email, domain: input.config.domain });
    const user = await tx.user.findUnique({ where: { userKey: identity.userKey },
      select: { id: true, tokenVersion: true, twoFaEnabled: true, lifecycleStatus: true } });
    return createChallenge(input, user?.twoFaEnabled && user.lifecycleStatus === 'ACTIVE' ? user : null, null, tx);
  });
}

/** Consume a real primary chooser proof; existing personal MFA remains required when enrolled. */
export async function startEnterpriseAccountLink(input: LinkInput & { loginToken: string }) {
  return getAdminPrisma().$transaction(async (tx) => {
    await lockEnterpriseOutbox(tx);
    await lockProductTeamPolicyShared(tx);
    const { context } = await requireEnterpriseLink(input, tx);
    const session = await verifyLoginSession({ prisma: tx, token: input.loginToken, config: input.config, configUrl: input.configUrl,
      sharedSecret: requireEnv('SHARED_SECRET').SHARED_SECRET, audience: LOGIN_SESSION_AUDIENCE });
    if (!session.authenticationEvidenceId || session.redirectUrl !== context.redirect_url ||
      session.codeChallenge !== context.code_challenge || session.state !== context.state) denied();
    const state = await lockAndAssertAuthenticationEpoch({ userId: session.userId, domain: input.config.domain,
      credentialEpoch: session.credentialEpoch }, { prisma: tx });
    const proof = await requireAuthenticationEvidence({ id: session.authenticationEvidenceId, userId: session.userId,
      credentialEpoch: session.credentialEpoch, clientDomain: input.config.domain }, tx);
    if (proof.provenance !== 'independent' || proof.purpose !== 'authorize') denied();
    await consumeLoginSession({ domain: session.domain, jti: session.jti, expiresAtEpochSeconds: session.expiresAtEpochSeconds, prisma: tx });
    const freshFactor = proof.mfaCompletedAt && proof.mfaCompletedAt.getTime() + 600000 > Date.now();
    const freshPassword = proof.method === 'email_password' && proof.authenticatedAt && proof.authenticatedAt.getTime() + 600000 > Date.now();
    if (freshFactor || (freshPassword && !state.twoFaEnabled)) return completeEnterpriseLink({ ...input,
      userId: session.userId, credentialEpoch: session.credentialEpoch, authenticationEvidenceId: proof.id }, tx);
    if (!state.twoFaEnabled) denied();
    return createChallenge(input, { id: session.userId, tokenVersion: session.credentialEpoch }, proof.id, tx);
  });
}

/** Failed guesses commit their bounded attempt count; only an existing factor can complete the link. */
export async function verifyLinkPersonalFactor(input: LinkInput & { challenge: string; code: string }) {
  const outcome = await getAdminPrisma().$transaction(async (tx) => {
    await lockEnterpriseOutbox(tx);
    await lockProductTeamPolicyShared(tx);
    const { link, context } = await requireEnterpriseLink(input, tx);
    const challenge = await tx.orgSsoPersonalFactorChallenge.findUnique({ where: { tokenHash: hashAssuranceReference(input.challenge) } });
    if (!challenge || challenge.linkIntentId !== link.id || challenge.browserHash !== link.browserHash) return null;
    const attempt = await tx.orgSsoPersonalFactorChallenge.updateMany({ where: { id: challenge.id, consumedAt: null,
      expiresAt: { gt: new Date() }, attempts: { lt: 6 } }, data: { attempts: { increment: 1 } } });
    if (attempt.count !== 1 || !challenge.userId || challenge.credentialEpoch === null) return null;
    if (!/^\d{6}$/.test(input.code)) return null;
    try {
      await lockAndAssertAuthenticationEpoch({ userId: challenge.userId, domain: input.config.domain,
        credentialEpoch: challenge.credentialEpoch }, { prisma: tx });
      if (challenge.authenticationEvidenceId) await requireAuthenticationEvidence({ id: challenge.authenticationEvidenceId,
        userId: challenge.userId, credentialEpoch: challenge.credentialEpoch, clientDomain: input.config.domain }, tx);
      await verifyTwoFactorForLogin({ userId: challenge.userId, code: input.code }, { prisma: tx });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 401) return null;
      throw error;
    }
    const evidenceId = await recordIndependentAuthentication({ userId: challenge.userId, credentialEpoch: challenge.credentialEpoch,
      method: 'personal_totp', verifiedEvent: { kind: 'local_credential' }, config: input.config, configUrl: input.configUrl,
      redirectUrl: context.redirect_url, codeChallenge: context.code_challenge }, tx);
    await tx.authenticationEvidence.update({ where: { id: evidenceId }, data: { mfaCompletedAt: new Date(), signatureCompletedAt: new Date() } });
    await tx.orgSsoPersonalFactorChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
    return completeEnterpriseLink({ ...input, userId: challenge.userId, credentialEpoch: challenge.credentialEpoch,
      authenticationEvidenceId: evidenceId }, tx);
  });
  if (!outcome) denied();
  return outcome;
}
