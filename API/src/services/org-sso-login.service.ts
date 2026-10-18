import { finalizeEnterpriseAdmission } from './org-sso-login-finalize.service.js';
import { getPublicBaseUrl } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { hashAssuranceReference } from './session-assurance.service.js';
import { requireLiveConnection, effectiveEnterpriseConnection } from './org-sso-entry.service.js';
import { EnterpriseAuthorization, reloadEnterpriseAuthorization } from './enterprise-authorization-context.service.js';
import { validateEnterpriseOidcCallback } from './org-sso-oidc.service.js';
import { validateEnterpriseSamlCallback } from './org-sso-saml.service.js';
import { admitEnterpriseIdentity } from './org-sso-admission.service.js';
import { lockEnterpriseOutbox } from './org-sso-revocation.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import { sealEnterpriseSecret } from './enterprise-secret.service.js';

/** Callback consumes upstream state once; all admission writes and final artifacts commit together. */
export async function finishEnterpriseLogin(connectionId: string, flowId: string, browser: string,
  response: { code?: string; iss?: string; SAMLResponse?: string }, ip?: string) {
  const db = getAdminPrisma();
  const flow = await db.orgSsoFlow.findUnique({ where: { id: flowId } });
  if (!flow || flow.connectionId !== connectionId || flow.mode !== 'login' || flow.consumedAt ||
    flow.expiresAt <= new Date() || flow.browserHash !== hashAssuranceReference(browser)) {
    throw new AppError('UNAUTHORIZED', 401, 'SSO_FLOW_INVALID');
  }
  const context = EnterpriseAuthorization.parse(flow.context);
  const config = await reloadEnterpriseAuthorization(context);
  const initial = await db.$transaction((tx) => requireLiveConnection(connectionId, tx));
  if (initial.connection.revision !== flow.revision || initial.policy.generation !== context.policy_generation) {
    throw new AppError('UNAUTHORIZED', 401, 'SSO_FLOW_INVALID');
  }
  const claim = await db.orgSsoFlow.updateMany({ where: { id: flowId, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() } });
  if (claim.count !== 1) throw new AppError('UNAUTHORIZED', 401, 'SSO_FLOW_INVALID');
  const effective = effectiveEnterpriseConnection(initial.connection, initial.policy.reauthMode, initial.policy.sessionMaxAgeSeconds);
  const identity = initial.connection.protocol === 'oidc' && response.code ?
    await validateEnterpriseOidcCallback(effective, flow, { code: response.code, iss: response.iss }) :
    initial.connection.protocol === 'saml' && response.SAMLResponse ?
      await validateEnterpriseSamlCallback(effective, response.SAMLResponse, flowId) : null;
  if (!identity) throw new AppError('UNAUTHORIZED', 401, 'SSO_ASSERTION_INVALID');
  return db.$transaction(async (tx) => {
    await lockEnterpriseOutbox(tx);
    await lockProductTeamPolicyShared(tx);
    const current = await requireLiveConnection(connectionId, tx);
    if (current.connection.revision !== flow.revision || current.connection.generation !== initial.connection.generation ||
      current.policy.generation !== context.policy_generation) throw new AppError('UNAUTHORIZED', 401, 'SSO_FLOW_INVALID');
    const admitted = await admitEnterpriseIdentity({ ...current, identity, config, context }, tx);
    if (admitted.kind === 'link_required') {
      const link = await tx.orgSsoLinkIntent.create({ data: { connectionId, clientDomain: current.connection.clientDomain,
        orgId: current.connection.orgId, revision: flow.revision, generation: current.connection.generation,
        flowId, browserHash: flow.browserHash,
        // Encrypt even temporary provider claims; this value is never returned to the browser.
        identity: { sealed: await sealEnterpriseSecret(JSON.stringify(identity), `link:${flowId}`) }, context,
        expiresAt: new Date(Math.min(flow.expiresAt.getTime(), identity.sessionExpiresAt.getTime())) } });
      const target = new URL('/auth', getPublicBaseUrl());
      target.searchParams.set('config_url', context.config_url);
      target.searchParams.set('redirect_url', context.redirect_url); target.searchParams.set('state', context.state);
      target.searchParams.set('code_challenge', context.code_challenge); target.searchParams.set('code_challenge_method', 'S256');
      target.searchParams.set('flow', 'enterprise_link'); target.searchParams.set('enterprise_link_intent', link.id);
      return { destination: target.toString(), retainBrowser: false, linkIntentId: link.id, linkExpiresAt: link.expiresAt };
    }
    return finalizeEnterpriseAdmission(admitted, config, context, tx, ip);
  });
}
