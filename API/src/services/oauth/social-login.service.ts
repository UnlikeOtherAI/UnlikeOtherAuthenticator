import type { FastifyReply, FastifyRequest } from 'fastify';
import { getEnv, getPublicBaseUrl } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { getGoogleProfileFromCode } from '../social/google.service.js';
import { loginWithSocialProfile } from '../social/social-login.service.js';
import { lockProductTeamPolicyShared } from '../product-team-policy-lock.service.js';
import { lockRefreshSessionUserDomain } from '../refresh-session-lock.service.js';
import { lockAndAssertAuthenticationEpoch } from '../authentication-epoch.service.js';
import { assertNotBannedAtLogin, isPrincipalBannedForRegistration } from '../ban-policy.service.js';
import { assertEmailDomainAllowedForLogin, isEmailAdminAllowedForRegistration } from '../login-domain-policy.service.js';
import { buildUserIdentity } from '../user-scope.service.js';
import { finalizePublicOAuthAuthorizationWithSignatures } from '../signature-continuation.service.js';
import { completePublicSecondFactor } from './second-factor.service.js';
import { resolvePublicContext, type PublicContext } from './authorization-context.service.js';
import { readPublicFlow, bindPublicCompletion, readPublicCompletion, clearPublicCompletion } from './social-ticket.service.js';
import { createKeyedRateLimiter } from '../../middleware/rate-limiter.js';
import { asPrismaClient } from '../../db/tenant-context.js';
import { renderAuthEntrypointHtml, sendAuthHtml, sendDeepLinkHandoff } from '../auth-ui.service.js';

const factorLimiter = createKeyedRateLimiter({ limit: 10, windowMs: 5 * 60_000 });

/** Separate public completion; never enters the confidential config/team/token flow. */
export async function handlePublicGoogleCallback(request: FastifyRequest, reply: FastifyReply, state: string, code: string | undefined, provider: string, error?: string) {
  const signed = await readPublicFlow(request, state);
  if (provider !== 'google') throw new AppError('UNAUTHORIZED', 401);
  const { config } = await resolvePublicContext(signed.context, 'google');
  const claimed = await request.adminDb.nativeOAuthFlow.updateMany({ where: { id: state, callbackUsedAt: null, usedAt: null, expiresAt: { gt: new Date() } }, data: { callbackUsedAt: new Date() } });
  if (claimed.count !== 1) throw new AppError('UNAUTHORIZED', 401);
  if (error) {
    clearPublicCompletion(reply, state);
    const target = new URL(signed.context.redirect_uri);
    target.searchParams.set('error', 'access_denied');
    if (signed.context.state) target.searchParams.set('state', signed.context.state);
    await sendDeepLinkHandoff(reply, { config, configUrl: 'urn:uoa:mcp', target: target.toString() });
    return;
  }
  if (!code) throw new AppError('BAD_REQUEST', 400);
  const env = getEnv();
  if (!env.MCP_OAUTH_PUBLIC_PROFILE_ENABLED || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new AppError('NOT_FOUND', 404);
  const profile = await getGoogleProfileFromCode({ code, clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: `${getPublicBaseUrl()}/auth/callback/google` });
  if (!profile.emailVerified) throw new AppError('UNAUTHORIZED', 401);
  await request.adminDb.$transaction(async (tx) => {
    await lockProductTeamPolicyShared(tx);
    const current = await resolvePublicContext(signed.context, 'google', tx);
    // Native app policy is a hard ceiling, independent of the shared tenant allowlist.
    if (!current.config.allow_registration) {
      const { userKey } = buildUserIdentity({ email: profile.email, domain: config.domain, userScope: config.user_scope });
      if (!await tx.user.findUnique({ where: { userKey }, select: { id: true } })) throw new AppError('UNAUTHORIZED', 401);
    }
    const result = await loginWithSocialProfile({ profile, config: current.config, ip: request.ip }, {
      prisma: tx, skipAutoPlacement: true,
      isPrincipalBannedForRegistration: (input) => isPrincipalBannedForRegistration(input, { prisma: tx }),
      isEmailAdminAllowedForRegistration: (input) => isEmailAdminAllowedForRegistration(input, { prisma: tx }),
      beforeExistingUserUpdate: (userId) => lockRefreshSessionUserDomain({ userId, domain: config.domain }, { prisma: tx }),
    });
    if (result.status !== 'authenticated' || result.credentialEpoch === undefined) throw new AppError('UNAUTHORIZED', 401);
    await lockAndAssertAuthenticationEpoch({ userId: result.userId, domain: config.domain, credentialEpoch: result.credentialEpoch }, { prisma: tx });
    await assertNotBannedAtLogin({ userId: result.userId, domain: config.domain, ip: request.ip }, { prisma: tx });
    await assertEmailDomainAllowedForLogin({ userId: result.userId, domain: config.domain }, { prisma: tx });
    await tx.nativeOAuthFlow.update({ where: { id: state }, data: { userId: result.userId, credentialEpoch: result.credentialEpoch } });
  });
  bindPublicCompletion(request, reply, state);
  // Render a document before the next request: a cross-site redirect chain would
  // not send a Strict cookie. The subsequent same-origin POST does.
  await renderCompletionContext(signed.context, reply, state);
}

export async function renderPublicCompletion(request: FastifyRequest, reply: FastifyReply) {
  const id = (request.query as { flow_id?: string }).flow_id ?? '';
  const ticket = await readPublicCompletion(request, id);
  await renderCompletionContext(ticket.context, reply, id);
}
async function renderCompletionContext(context: PublicContext, reply: FastifyReply, id: string) {
  const { config } = await resolvePublicContext(context, 'google');
  const query = new URLSearchParams(Object.entries(context).filter((e): e is [string, string] => typeof e[1] === 'string'));
  query.set('native_social_complete', 'true');
  query.set('native_flow_id', id);
  sendAuthHtml(reply, await renderAuthEntrypointHtml({ config, configUrl: 'urn:uoa:mcp',
    requestUrl: `/oauth/social/complete?${query}`, cspNonce: reply.cspNonce?.script }));
}

export async function completePublicSocial(request: FastifyRequest, body: { flow_id: string; code?: string; setup_token?: string }) {
  const preview = await readPublicCompletion(request, body.flow_id);
  factorLimiter(`native-factor:${preview.userId}`);
  return request.adminDb.$transaction(async (tx) => {
    await lockProductTeamPolicyShared(tx);
    const ticket = await readPublicCompletion(request, body.flow_id, tx);
    const { config, client } = await resolvePublicContext(ticket.context, 'google', tx);
    const user = await lockAndAssertAuthenticationEpoch({ ...ticket, domain: config.domain }, { prisma: tx });
    await assertNotBannedAtLogin({ userId: ticket.userId, domain: config.domain, ip: request.ip }, { prisma: tx });
    await assertEmailDomainAllowedForLogin({ userId: ticket.userId, domain: config.domain }, { prisma: tx });
    const factor = await completePublicSecondFactor({ ...ticket, twoFaEnabled: user.twoFaEnabled, config,
      code: body.code, setupToken: body.setup_token }, asPrismaClient(tx));
    if (factor.response) return factor.response;
    const consumed = await tx.nativeOAuthFlow.updateMany({ where: { id: ticket.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (consumed.count !== 1) throw new AppError('UNAUTHORIZED', 401);
    const q = ticket.context;
    const gate = await finalizePublicOAuthAuthorizationWithSignatures({ userId: ticket.userId,
      credentialEpoch: ticket.credentialEpoch, domain: config.domain, oauthClientId: client.clientId,
      redirectUrl: q.redirect_uri, codeChallenge: q.code_challenge, scope: q.scope, state: q.state,
      resource: q.resource, rememberMe: false, authMethod: 'google', twoFaCompleted: factor.completed === true,
    }, { prisma: asPrismaClient(tx) });
    return { ok: true, redirect_to: gate.redirectTo };
  });
}
