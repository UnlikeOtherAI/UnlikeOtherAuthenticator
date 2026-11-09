import type { FastifyRequest } from 'fastify';
import type { SocialProfile } from '../social/provider.base.js';
import type { PublicContext } from './authorization-context.service.js';
import { resolvePublicContext } from './authorization-context.service.js';
import { recordIndependentAuthentication } from '../authentication-evidence.service.js';
import { loginWithSocialProfile } from '../social/social-login.service.js';
import { bindFacebookIdentity } from '../social/facebook-email-proof-callback.service.js';
import { lockProductTeamPolicyShared } from '../product-team-policy-lock.service.js';
import { lockRefreshSessionUserDomain } from '../refresh-session-lock.service.js';
import { lockAndAssertAuthenticationEpoch } from '../authentication-epoch.service.js';
import { assertNotBannedAtLogin, isPrincipalBannedForRegistration } from '../ban-policy.service.js';
import { assertEmailDomainAllowedForLogin, isEmailAdminAllowedForRegistration } from '../login-domain-policy.service.js';
import { buildUserIdentity } from '../user-scope.service.js';
import { AppError } from '../../utils/errors.js';

/** Account admission and source evidence commit together under current app/account policy. */
export async function authenticatePublicSocialProfile(request: FastifyRequest, context: PublicContext,
  state: string, profile: SocialProfile, proofId: string | null) {
  if (!profile.emailVerified) throw new AppError('UNAUTHORIZED', 401);
  await request.adminDb.$transaction(async (tx) => {
    await lockProductTeamPolicyShared(tx);
    const { config } = await resolvePublicContext(context, profile.provider, tx);
    if (!config.allow_registration) {
      const { userKey } = buildUserIdentity({ email: profile.email, domain: config.domain, userScope: config.user_scope });
      if (!await tx.user.findUnique({ where: { lifecycleStatus: 'ACTIVE', userKey }, select: { id: true } })) throw new AppError('UNAUTHORIZED', 401);
    }
    const result = await loginWithSocialProfile({ profile, config, ip: request.ip }, {
      prisma: tx, skipAutoPlacement: true,
      isPrincipalBannedForRegistration: (input) => isPrincipalBannedForRegistration(input, { prisma: tx }),
      isEmailAdminAllowedForRegistration: (input) => isEmailAdminAllowedForRegistration(input, { prisma: tx }),
      beforeExistingUserUpdate: (userId) => lockRefreshSessionUserDomain({ userId, domain: config.domain }, { prisma: tx }),
    });
    if (result.status !== 'authenticated' || result.credentialEpoch === undefined) throw new AppError('UNAUTHORIZED', 401);
    await lockAndAssertAuthenticationEpoch({ userId: result.userId, domain: config.domain, credentialEpoch: result.credentialEpoch }, { prisma: tx });
    await assertNotBannedAtLogin({ userId: result.userId, domain: config.domain, ip: request.ip }, { prisma: tx });
    await assertEmailDomainAllowedForLogin({ userId: result.userId, domain: config.domain }, { prisma: tx });
    if (profile.provider === 'facebook') await bindFacebookIdentity({ userId: result.userId, profile, proofId, prisma: tx });
    const authenticationEvidenceId = await recordIndependentAuthentication({ userId: result.userId,
      credentialEpoch: result.credentialEpoch, method: profile.provider, verifiedEvent: { kind: 'provider', authenticatedAt: null },
      config, configUrl: 'urn:uoa:mcp', redirectUrl: context.redirect_uri, codeChallenge: context.code_challenge }, tx);
    const accepted = await tx.nativeOAuthFlow.updateMany({ where: { id: state, userId: null, usedAt: null,
      callbackUsedAt: { not: null }, expiresAt: { gt: new Date() } },
      data: { userId: result.userId, credentialEpoch: result.credentialEpoch, authenticationEvidenceId } });
    if (accepted.count !== 1) throw new AppError('UNAUTHORIZED', 401);
  });
}
