import type { FastifyReply, FastifyRequest } from 'fastify';
import { getEnv, getPublicBaseUrl } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { getSocialProfileFromCode } from '../social/provider-profile.service.js';
import { SocialProviderSchema, type SocialProviderKey } from '../social/provider.base.js';
import { prepareFacebookProfile } from '../social/facebook-email-proof-callback.service.js';
import { parseFacebookProofCode, readFacebookProofCookie, clearFacebookProofCookie } from '../social/facebook-email-proof.service.js';
import { lockProductTeamPolicyShared } from '../product-team-policy-lock.service.js';
import { lockAndAssertAuthenticationEpoch } from '../authentication-epoch.service.js';
import { assertNotBannedAtLogin } from '../ban-policy.service.js';
import { assertEmailDomainAllowedForLogin } from '../login-domain-policy.service.js';
import { finalizePublicOAuthAuthorizationWithSignatures } from '../signature-continuation.service.js';
import { completePublicSecondFactor } from './second-factor.service.js';
import { resolvePublicContext, type PublicContext } from './authorization-context.service.js';
import { readPublicFlow, bindPublicCompletion, readPublicCompletion, clearPublicCompletion } from './social-ticket.service.js';
import { authenticatePublicSocialProfile } from './social-profile.service.js';
import { createKeyedRateLimiter } from '../../middleware/rate-limiter.js';
import { asPrismaClient } from '../../db/tenant-context.js';
import { renderAuthEntrypointHtml, sendAuthHtml, sendDeepLinkHandoff } from '../auth-ui.service.js';

const factorLimiter = createKeyedRateLimiter({ limit: 10, windowMs: 5 * 60_000 });

/** Separate public completion; never enters the confidential config/team/token flow. */
export async function handlePublicSocialCallback(request: FastifyRequest, reply: FastifyReply, state: string,
  code: string | undefined, callbackProvider: string, error?: string) {
  const signed = await readPublicFlow(request, state);
  const provider = SocialProviderSchema.parse(callbackProvider);
  if (provider === 'facebook') clearFacebookProofCookie(reply);
  if (provider !== signed.provider || signed.userId) throw new AppError('UNAUTHORIZED', 401);
  const { config } = await resolvePublicContext(signed.context, provider);
  if (!getEnv().MCP_OAUTH_PUBLIC_PROFILE_ENABLED) throw new AppError('NOT_FOUND', 404);
  const proofId = provider === 'facebook' && code ? parseFacebookProofCode(code) : null;
  if (proofId) {
    if (!signed.callbackUsedAt || error) throw new AppError('UNAUTHORIZED', 401);
  } else {
    const claimed = await request.adminDb.nativeOAuthFlow.updateMany({ where: { id: state, callbackUsedAt: null,
      usedAt: null, expiresAt: { gt: new Date() } }, data: { callbackUsedAt: new Date() } });
    if (claimed.count !== 1) throw new AppError('UNAUTHORIZED', 401);
  }
  if (error) {
    clearPublicCompletion(reply, state);
    const target = new URL(signed.context.redirect_uri);
    target.searchParams.set('error', 'access_denied');
    if (signed.context.state) target.searchParams.set('state', signed.context.state);
    await sendDeepLinkHandoff(reply, { config, configUrl: 'urn:uoa:mcp', target: target.toString() });
    return;
  }
  if (!code) throw new AppError('BAD_REQUEST', 400);
  let profile = proofId ? null : await getSocialProfileFromCode(provider, code, getPublicBaseUrl(), signed.codeVerifier);
  if (provider === 'facebook') {
    const prepared = await prepareFacebookProfile({ profile, proofId, proofCookie: readFacebookProofCookie(request),
      stateJwt: state, state: { native_flow_id: state }, inviteToken: null, config, prisma: request.adminDb, reply });
    if (!prepared) {
      bindPublicCompletion(request, reply, state);
      await renderCompletionContext(signed.context, provider, reply, state, true);
      return;
    }
    profile = prepared.profile;
  }
  if (!profile || profile.provider !== provider) throw new AppError('UNAUTHORIZED', 401);
  await authenticatePublicSocialProfile(request, signed.context, state, profile, proofId);
  bindPublicCompletion(request, reply, state);
  // Render a document before the next request: a cross-site redirect chain would
  // not send a Strict cookie. The subsequent same-origin POST does.
  await renderCompletionContext(signed.context, provider, reply, state);
}

export async function renderPublicCompletion(request: FastifyRequest, reply: FastifyReply) {
  const id = (request.query as { flow_id?: string }).flow_id ?? '';
  const pending = await readPublicFlow(request, id);
  if (pending.provider === 'facebook' && pending.callbackUsedAt && !pending.userId) {
    await renderCompletionContext(pending.context, pending.provider, reply, id, true);
    return;
  }
  const ticket = await readPublicCompletion(request, id);
  await renderCompletionContext(ticket.context, ticket.provider, reply, id);
}
async function renderCompletionContext(context: PublicContext, provider: SocialProviderKey,
  reply: FastifyReply, id: string, facebookProof = false) {
  const { config } = await resolvePublicContext(context, provider);
  const query = new URLSearchParams(Object.entries(context).filter((e): e is [string, string] => typeof e[1] === 'string'));
  if (facebookProof) query.set('flow', 'facebook_proof');
  else query.set('native_social_complete', 'true');
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
    const { config, client } = await resolvePublicContext(ticket.context, ticket.provider, tx);
    const user = await lockAndAssertAuthenticationEpoch({ ...ticket, domain: config.domain }, { prisma: tx });
    await assertNotBannedAtLogin({ userId: ticket.userId, domain: config.domain, ip: request.ip }, { prisma: tx });
    await assertEmailDomainAllowedForLogin({ userId: ticket.userId, domain: config.domain }, { prisma: tx });
    const factor = await completePublicSecondFactor({ ...ticket, twoFaEnabled: user.twoFaEnabled, config,
      authenticationEvidenceId: ticket.authenticationEvidenceId ?? undefined, authMethod: ticket.provider,
      code: body.code, setupToken: body.setup_token }, asPrismaClient(tx));
    if (factor.response) return factor.response;
    const consumed = await tx.nativeOAuthFlow.updateMany({ where: { id: ticket.id, usedAt: null,
      expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (consumed.count !== 1) throw new AppError('UNAUTHORIZED', 401);
    const q = ticket.context;
    const gate = await finalizePublicOAuthAuthorizationWithSignatures({ userId: ticket.userId,
      authenticationEvidenceId: ticket.authenticationEvidenceId ?? undefined,
      credentialEpoch: ticket.credentialEpoch, domain: config.domain, oauthClientId: client.clientId,
      redirectUrl: q.redirect_uri, codeChallenge: q.code_challenge, scope: q.scope, state: q.state,
      resource: q.resource, rememberMe: false, authMethod: ticket.provider, twoFaCompleted: factor.completed === true,
    }, { prisma: asPrismaClient(tx) });
    return { ok: true, redirect_to: gate.redirectTo };
  });
}
