import type { Prisma, OrgSsoConnection } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { getPublicBaseUrl } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import { hashAssuranceReference } from './session-assurance.service.js';
import { randomEnterpriseValue, enterpriseOidcAuthorize } from './org-sso-oidc.service.js';
import { enterpriseSamlAuthorize } from './org-sso-saml.service.js';
import { sealEnterpriseSecret } from './enterprise-secret.service.js';
import { enterpriseAuthorizationContext } from './enterprise-authorization-context.service.js';
import { resolveProductTeamPolicy } from './product-team-policy.service.js';

export async function requireLiveConnection(connectionId: string, db: Prisma.TransactionClient) {
  const connection = await db.orgSsoConnection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.status !== 'active' || connection.testedRevision !== connection.revision) {
    throw new AppError('FORBIDDEN', 403, 'SSO_CONNECTION_UNAVAILABLE');
  }
  const [policy, product, client, org] = await Promise.all([
    db.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: { clientDomain: connection.clientDomain, orgId: connection.orgId } } }),
    db.enterpriseProductReadiness.findUnique({ where: { clientDomain: connection.clientDomain } }),
    db.clientDomain.findUnique({ where: { domain: connection.clientDomain } }),
    db.organisation.findUnique({ where: { id: connection.orgId }, select: { domain: true, lifecycleStatus: true } }),
  ]);
  if (!policy?.arrangementEnabled || product?.minimumAssuranceVersion !== 1 || !product.authorityMigrationRevision ||
    !product.revocationConsumersRevision || client?.status !== 'active' || org?.lifecycleStatus !== 'ACTIVE') {
    throw new AppError('FORBIDDEN', 403, 'SSO_ACTIVATION_NOT_READY');
  }
  const reach = await resolveProductTeamPolicy({ domain: connection.clientDomain }, { prisma: db });
  if (org.domain !== connection.clientDomain && reach.scope !== 'all_active_memberships') throw new AppError('FORBIDDEN', 403, 'SSO_PRODUCT_ORG_INVALID');
  return { connection, policy, product };
}

/** A stable IdP tile starts the relying party's own PKCE/state flow, never its callback. */
export async function enterpriseTileRedirect(connectionId: string) {
  return getAdminPrisma().$transaction(async (tx) => {
    const { connection, product } = await requireLiveConnection(connectionId, tx);
    if (!product.loginEntryUrl || !product.configUrl) throw new AppError('FORBIDDEN', 403, 'SSO_RELYING_ENTRY_REQUIRED');
    const token = randomEnterpriseValue();
    await tx.orgSsoRelyingIntent.create({ data: { tokenHash: hashAssuranceReference(token), clientDomain: connection.clientDomain,
      connectionId, revision: connection.revision, generation: connection.generation, expiresAt: new Date(Date.now() + 120000) } });
    const url = new URL(product.loginEntryUrl); url.searchParams.set('sso_intent', token);
    return url.toString();
  });
}

export async function startEnterpriseLogin(input: { connectionId?: string; relyingIntent?: string;
  config: ClientConfig; configUrl: string; query: unknown }) {
  const browser = randomEnterpriseValue();
  const result = await getAdminPrisma().$transaction(async (tx) => {
    const intent = input.relyingIntent ? await tx.orgSsoRelyingIntent.findUnique({ where: {
      tokenHash: hashAssuranceReference(input.relyingIntent) } }) : null;
    if (input.relyingIntent && (!intent || intent.consumedAt || intent.expiresAt <= new Date() || intent.clientDomain !== input.config.domain)) {
      throw new AppError('UNAUTHORIZED', 401, 'SSO_RELYING_INTENT_INVALID');
    }
    const id = input.connectionId ?? intent?.connectionId;
    if (!id) throw new AppError('BAD_REQUEST', 400, 'SSO_CONNECTION_REQUIRED');
    const { connection, policy, product } = await requireLiveConnection(id, tx);
    if (intent && product.configUrl !== input.configUrl) throw new AppError('UNAUTHORIZED', 401, 'SSO_RELYING_INTENT_INVALID');
    if (connection.clientDomain !== input.config.domain || (intent && (intent.connectionId !== id ||
      intent.revision !== connection.revision || intent.generation !== connection.generation))) throw new AppError('UNAUTHORIZED', 401, 'SSO_RELYING_INTENT_INVALID');
    const context = enterpriseAuthorizationContext(input.config, input.configUrl, input.query, policy.generation);
    if (intent) {
      const claim = await tx.orgSsoRelyingIntent.updateMany({ where: { id: intent.id, consumedAt: null }, data: { consumedAt: new Date() } });
      if (claim.count !== 1) throw new AppError('UNAUTHORIZED', 401, 'SSO_RELYING_INTENT_INVALID');
    }
    const flowId = randomEnterpriseValue(); const verifier = randomEnterpriseValue();
    const flow = await tx.orgSsoFlow.create({ data: { id: flowId, connectionId: id, revision: connection.revision,
      browserHash: hashAssuranceReference(browser), nonce: randomEnterpriseValue(), mode: 'login',
      encryptedVerifier: await sealEnterpriseSecret(verifier, `flow:${flowId}`), context,
      expiresAt: new Date(Date.now() + 600000) } });
    const effective = effectiveEnterpriseConnection(connection, policy.reauthMode, policy.sessionMaxAgeSeconds);
    const target = connection.protocol === 'oidc' ? enterpriseOidcAuthorize(effective, flow, verifier) :
      await enterpriseSamlAuthorize(effective, flow, tx);
    return { flowId, target, expiresAt: flow.expiresAt };
  });
  return { ...result, browser, cookieSecure: new URL(getPublicBaseUrl()).protocol === 'https:' };
}

export function effectiveEnterpriseConnection(connection: OrgSsoConnection, reauthMode: string, maxAge: number): OrgSsoConnection {
  if (reauthMode !== 'force') return connection;
  const configuration = connection.configuration as Record<string, Prisma.JsonValue>;
  return { ...connection, configuration: { ...configuration,
    ...(connection.protocol === 'oidc' ? { max_age: maxAge } : { force_authn: true }) } };
}
