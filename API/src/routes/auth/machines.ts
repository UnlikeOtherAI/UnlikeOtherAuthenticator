import type { FastifyInstance, FastifyRequest } from 'fastify';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { LOGIN_SESSION_AUDIENCE } from '../../config/constants.js';
import { getPublicBaseUrl, requireEnv } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireSameOriginBrowserRequest } from '../../middleware/same-origin-browser.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { lockProductTeamPolicyShared } from '../../services/product-team-policy-lock.service.js';
import { lockAndAssertAuthenticationEpoch } from '../../services/authentication-epoch.service.js';
import { verifyLoginSession } from '../../services/login-session.service.js';
import { consumeLoginSession } from '../../services/login-session-use.service.js';
import { finalizeWithTwoFaPolicy } from '../../services/team-finalize.service.js';
import { machineBoundary, machineTransaction } from '../../services/machine-authority.service.js';
import { machineRefused } from '../../services/machine-crypto.js';
import { createMachineBrowser, machineBrowser } from '../../services/machine-browser.service.js';
import { approveMachineConsent, machineConsentView } from '../../services/machine-consent.service.js';
import { revokeOwnedMachines } from '../../services/machine-revoke.service.js';
import { fingerprintClientConfig } from '../../services/client-config-fingerprint.service.js';
import { renderAuthEntrypointHtml, sendAuthHtml } from '../../services/auth-ui.service.js';
import { readAdminConfigJwt } from '../../services/admin-auth-config.service.js';
import { validateConfigFields } from '../../services/config.service.js';

const COOKIE = 'uoa_machine_session';
const csrf = (request: FastifyRequest) => typeof request.headers['x-uoa-csrf'] === 'string'
  ? request.headers['x-uoa-csrf'] as string : machineRefused();

export function registerMachineBrowserRoutes(app: FastifyInstance) {
  const limiter = createRateLimiter({ keyBuilder: request => `machine-browser:${request.ip}`, limit: 30, windowMs: 60000 });
  app.get('/auth/machines', async (request, reply) => {
    const config = validateConfigFields(decodeJwt(readAdminConfigJwt()));
    const html = await renderAuthEntrypointHtml({ config: { ...config, language_config: ['en', 'cs', 'es'] },
      configUrl: `${getPublicBaseUrl()}/internal/admin/config`, requestUrl: request.raw.url, cspNonce: reply.cspNonce?.script });
    sendAuthHtml(reply, html);
  });
  app.post('/auth/machines/start', { preHandler: [requireSameOriginBrowserRequest, limiter, configVerifier] }, async (request, reply) => {
    const body = z.object({ login_token: z.string().min(1).max(4096), organization_id: z.string().min(1).max(100),
      team_id: z.string().min(1).max(100), request_id: z.uuid().optional() }).strict().parse(request.body);
    const config = request.config; const configUrl = request.configUrl;
    if (!config || !configUrl) machineRefused();
    const verify = (prisma: typeof request.adminDb) => verifyLoginSession({ prisma, token: body.login_token,
      config, configUrl, sharedSecret: requireEnv('SHARED_SECRET').SHARED_SECRET, audience: LOGIN_SESSION_AUDIENCE });
    const source = await verify(request.adminDb);
    const outcome = await machineTransaction(async tx => {
      await lockProductTeamPolicyShared(tx);
      const identity = await lockAndAssertAuthenticationEpoch({ userId: source.userId, domain: source.domain,
        credentialEpoch: source.credentialEpoch }, { prisma: tx });
      const session = await verify(tx);
      await consumeLoginSession({ domain: session.domain, jti: session.jti,
        expiresAtEpochSeconds: session.expiresAtEpochSeconds, prisma: tx });
      const created = await createMachineBrowser({ userId: session.userId, domain: session.domain,
        credentialEpoch: session.credentialEpoch, evidenceId: session.authenticationEvidenceId, config, configUrl,
        orgId: body.organization_id, teamId: body.team_id, requestId: body.request_id,
        codeChallenge: session.codeChallenge, state: session.state }, tx);
      const finalized = await finalizeWithTwoFaPolicy({ userId: session.userId, credentialEpoch: session.credentialEpoch,
        twoFaEnabled: identity.twoFaEnabled, config, configUrl, redirectUrl: session.redirectUrl, state: session.state,
        rememberMe: false, requestAccess: false, authMethod: session.authMethod,
        authenticationEvidenceId: session.authenticationEvidenceId, machineIntentId: created.session.id,
        orgId: body.organization_id, teamId: body.team_id,
        codeChallenge: session.codeChallenge, codeChallengeMethod: session.codeChallengeMethod },
        { policyLockHeld: true, prisma: tx, policyPrisma: tx, teamPrisma: tx, currentTwoFaEnabled: identity.twoFaEnabled });
      return { ...created, finalized };
    });
    reply.setCookie(COOKIE, outcome.browser, { path: '/auth/machines', httpOnly: true, sameSite: 'strict',
      secure: new URL(getPublicBaseUrl()).protocol === 'https:', expires: outcome.session.expiresAt });
    reply.header('Cache-Control', 'private, no-store');
    if (outcome.finalized.kind === 'twofa') return { ok: true, twofa_required: true, twofa_token: outcome.finalized.twofa_token };
    if (outcome.finalized.kind === 'twofa_enroll_required') return { ok: true, kind: 'twofa_enroll_required',
      twofa_enroll_required: true, ...outcome.finalized.setup };
    return { ok: true, redirect_to: outcome.finalized.finalResult.redirectTo };
  });
  app.get('/auth/machines/state', { preHandler: limiter }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return machineTransaction(async tx => {
      const session = await machineBrowser(request.cookies[COOKIE], tx);
      return { ...await machineConsentView(session, tx), config_url: session.configUrl };
    });
  });
  app.post('/auth/machines/consent', { preHandler: [requireSameOriginBrowserRequest, limiter, configVerifier] }, async (request, reply) => {
    const { approved } = z.object({ approved: z.boolean() }).strict().parse(request.body);
    const suppliedCsrf = csrf(request);
    reply.header('Cache-Control', 'private, no-store');
    return machineTransaction(async tx => {
      const session = await machineBrowser(request.cookies[COOKIE], tx, suppliedCsrf);
      if (!request.config || request.configUrl !== session.configUrl ||
        fingerprintClientConfig(request.config) !== session.configFingerprint) machineRefused(409, 'MACHINE_REQUEST_CONFLICT');
      return approveMachineConsent(session, approved, tx);
    });
  });
  app.post('/auth/machines/:id/revoke', { preHandler: [requireSameOriginBrowserRequest, limiter] }, async (request, reply) => {
    const { id } = z.object({ id: z.union([z.uuid(), z.literal('all')]) }).parse(request.params);
    z.object({}).strict().parse(request.body); const suppliedCsrf = csrf(request);
    reply.header('Cache-Control', 'private, no-store');
    return machineBoundary(() => machineTransaction(async tx => revokeOwnedMachines(
      await machineBrowser(request.cookies[COOKIE], tx, suppliedCsrf), id, tx)));
  });
}
