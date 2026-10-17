import type { Prisma } from '@prisma/client';
import { getPublicBaseUrl } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { hashAssuranceReference } from './session-assurance.service.js';
import { sealEnterpriseSecret } from './enterprise-secret.service.js';
import { validateEnterpriseConfiguration } from './org-sso-configuration.service.js';
import { enterpriseOidcAuthorize, randomEnterpriseValue, validateEnterpriseOidcCallback } from './org-sso-oidc.service.js';
import { enterpriseSamlAuthorize, validateEnterpriseSamlCallback } from './org-sso-saml.service.js';
import { lockEnterpriseScope, type managementSession } from './org-sso-management.service.js';

export async function startEnterpriseTest(session: Awaited<ReturnType<typeof managementSession>>,
  id: string, revision: number, browser: string, tx: Prisma.TransactionClient) {
  const connection = await tx.orgSsoConnection.findFirst({ where: { id, clientDomain: session.clientDomain,
    orgId: session.orgId, revision } });
  if (!connection) throw new AppError('BAD_REQUEST', 409, 'SSO_REVISION_CONFLICT');
  validateEnterpriseConfiguration(connection.preset, connection.protocol, connection.configuration);
  const flowId = randomEnterpriseValue(); const verifier = randomEnterpriseValue();
  const flow = await tx.orgSsoFlow.create({ data: { id: flowId, connectionId: id, revision,
    browserHash: hashAssuranceReference(browser), nonce: randomEnterpriseValue(),
    encryptedVerifier: await sealEnterpriseSecret(verifier, `flow:${flowId}`), mode: 'test', managementSessionId: session.id,
    context: {}, expiresAt: new Date(Math.min(Date.now() + 600000, session.expiresAt.getTime())) } });
  const target = connection.protocol === 'oidc' ? enterpriseOidcAuthorize(connection, flow, verifier) :
    await enterpriseSamlAuthorize(connection, flow, tx);
  await tx.orgSsoFlow.update({ where: { id: flowId }, data: { context: { authorize_url: target } } });
  await tx.orgSsoConnection.update({ where: { id }, data: { status: connection.status === 'active' ? 'active' : 'testing' } });
  return { ok: true, test_url: `${getPublicBaseUrl()}/sso/${id}/test?flow=${flowId}`,
    flow_id: flowId, expires_at: flow.expiresAt.toISOString() };
}

/** Test mode ends in a redacted connection result, never user writes, placement, linking or token issue. */
export async function finishEnterpriseTest(connectionId: string, flowId: string, browser: string,
  response: { code?: string; iss?: string; SAMLResponse?: string }) {
  const db = getAdminPrisma();
  const flow = await db.orgSsoFlow.findUnique({ where: { id: flowId } });
  if (!flow || flow.connectionId !== connectionId || flow.mode !== 'test' || flow.expiresAt <= new Date() ||
    flow.consumedAt || flow.browserHash !== hashAssuranceReference(browser)) {
    throw new AppError('UNAUTHORIZED', 401, 'SSO_FLOW_INVALID');
  }
  const connection = await db.orgSsoConnection.findUniqueOrThrow({ where: { id: connectionId } });
  if (connection.revision !== flow.revision || !['testing', 'active'].includes(connection.status)) {
    throw new AppError('UNAUTHORIZED', 401, 'SSO_FLOW_INVALID');
  }
  const consumed = await db.orgSsoFlow.updateMany({ where: { id: flowId, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() } });
  if (consumed.count !== 1) throw new AppError('UNAUTHORIZED', 401, 'SSO_FLOW_INVALID');
  let passed = false;
  try {
    if (connection.protocol === 'oidc' && response.code) {
      await validateEnterpriseOidcCallback(connection, flow, { code: response.code, iss: response.iss });
    } else if (connection.protocol === 'saml' && response.SAMLResponse) {
      await validateEnterpriseSamlCallback(connection, response.SAMLResponse, flow.id);
    } else throw new AppError('UNAUTHORIZED', 401, 'SSO_ASSERTION_INVALID');
    passed = true;
  } catch { /* Public test diagnostics deliberately contain no raw provider response or claims. */ }
  await db.$transaction(async (tx) => {
    await lockEnterpriseScope(tx, connection.clientDomain, connection.orgId);
    const session = flow.managementSessionId ? await tx.orgSsoManagementSession.findUnique({
      where: { id: flow.managementSessionId } }) : null;
    if (!session || session.revokedAt || session.expiresAt <= new Date()) passed = false;
    await tx.orgSsoConnection.updateMany({ where: { id: connectionId, revision: flow.revision,
      status: { in: ['testing', 'active'] } }, data: { testedRevision: passed ? flow.revision : null,
      lastTestCode: passed ? 'PASSED' : 'PROVIDER_VALIDATION_FAILED', lastTestAt: new Date() } });
  });
  return `${getPublicBaseUrl()}/auth/organisation-access?test=${encodeURIComponent(connectionId)}`;
}
