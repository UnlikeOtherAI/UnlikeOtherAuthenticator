import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LOGIN_SESSION_AUDIENCE } from '../../config/constants.js';
import { getPublicBaseUrl, requireEnv } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireSameOriginBrowserRequest } from '../../middleware/same-origin-browser.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { asPrismaClient } from '../../db/tenant-context.js';
import { getAdminPrisma } from '../../db/prisma.js';
import { verifyLoginSession } from '../../services/login-session.service.js';
import { consumeLoginSession } from '../../services/login-session-use.service.js';
import { lockAndAssertAuthenticationEpoch } from '../../services/authentication-epoch.service.js';
import { lockProductTeamPolicyShared } from '../../services/product-team-policy-lock.service.js';
import { resolveProductTeamPolicy } from '../../services/product-team-policy.service.js';
import { createManagementIntent } from '../../services/org-sso-management-intent.service.js';
import { finalizeWithTwoFaPolicy } from '../../services/team-finalize.service.js';
import { AppError } from '../../utils/errors.js';

export function registerOrganisationAccessStart(app: FastifyInstance) {
  const limiter = createRateLimiter({ keyBuilder: (request) => `management-start:${request.ip}`, limit: 15, windowMs: 60000 });
  app.post('/auth/organisation-access/start', { preHandler: [requireSameOriginBrowserRequest, limiter, configVerifier] }, async (request, reply) => {
    const body = z.object({ login_token: z.string().min(1).max(4096), org_id: z.string().min(1).max(100) }).strict().parse(request.body);
    const config = request.config; const configUrl = request.configUrl;
    if (!config || !configUrl) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
    const session = await verifyLoginSession({ token: body.login_token, config, configUrl,
      sharedSecret: requireEnv('SHARED_SECRET').SHARED_SECRET, audience: LOGIN_SESSION_AUDIENCE });
    const browser = randomBytes(32).toString('base64url');
    const result = await getAdminPrisma().$transaction(async (tx) => {
      await lockProductTeamPolicyShared(tx);
      const identity = await lockAndAssertAuthenticationEpoch({ userId: session.userId, domain: session.domain,
        credentialEpoch: session.credentialEpoch }, { prisma: tx });
      const [org, policy] = await Promise.all([
        tx.organisation.findUnique({ where: { id: body.org_id }, select: { domain: true } }),
        resolveProductTeamPolicy({ domain: session.domain }, { prisma: tx }),
      ]);
      if (!org || (org.domain !== session.domain && policy.scope !== 'all_active_memberships')) {
        throw new AppError('FORBIDDEN', 403, 'SSO_MANAGEMENT_REAUTH_REQUIRED');
      }
      await consumeLoginSession({ domain: session.domain, jti: session.jti,
        expiresAtEpochSeconds: session.expiresAtEpochSeconds, prisma: tx });
      const intent = await createManagementIntent({ userId: session.userId, credentialEpoch: session.credentialEpoch,
        clientDomain: session.domain, orgId: body.org_id, authenticationEvidenceId: session.authenticationEvidenceId, browser }, tx);
      return finalizeWithTwoFaPolicy({ userId: session.userId, credentialEpoch: session.credentialEpoch,
        config, configUrl, redirectUrl: session.redirectUrl, state: session.state, authMethod: session.authMethod,
        authenticationEvidenceId: session.authenticationEvidenceId, managementIntentId: intent.id,
        rememberMe: false, requestAccess: false, twoFaEnabled: identity.twoFaEnabled,
        codeChallenge: session.codeChallenge, codeChallengeMethod: session.codeChallengeMethod, orgId: body.org_id },
      { policyLockHeld: true, prisma: asPrismaClient(tx), policyPrisma: asPrismaClient(tx), currentTwoFaEnabled: identity.twoFaEnabled });
    });
    reply.setCookie('uoa_management_intent', browser, { path: '/auth', httpOnly: true, sameSite: 'strict',
      secure: new URL(getPublicBaseUrl()).protocol === 'https:', maxAge: 600 });
    reply.header('Cache-Control', 'no-store');
    if (result.kind === 'twofa') return { ok: true, twofa_required: true, twofa_token: result.twofa_token };
    if (result.kind === 'twofa_enroll_required') return { ok: true, kind: 'twofa_enroll_required', twofa_enroll_required: true, ...result.setup };
    return { ok: true, redirect_to: result.finalResult.redirectTo };
  });
}
