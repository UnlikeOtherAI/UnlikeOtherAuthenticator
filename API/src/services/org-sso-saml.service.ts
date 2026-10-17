import { createHash, X509Certificate } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { SAML, ValidateInResponseTo, generateServiceProviderMetadata, type CacheProvider } from '@node-saml/node-saml';
import { z } from 'zod';
import type { OrgSsoConnection, OrgSsoFlow, Prisma } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { getPublicBaseUrl } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { SamlEnterpriseConfiguration } from './org-sso-configuration.service.js';
import { openEnterpriseSecret } from './enterprise-secret.service.js';
import type { VerifiedEnterpriseIdentity } from './org-sso-oidc.service.js';

const NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const STRONG_SIGNATURES = new Set(['http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512']);
const STRONG_DIGESTS = new Set(['http://www.w3.org/2001/04/xmlenc#sha256', 'http://www.w3.org/2001/04/xmlenc#sha512']);
function invalid(): never { throw new AppError('UNAUTHORIZED', 401, 'SSO_ASSERTION_INVALID'); }

/** Structural hardening only; signature parsing and verification belong to maintained node-saml. */
export function parseBoundedSaml(xml: string) {
  if (Buffer.byteLength(xml) > 262144 || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) invalid();
  let errors = false;
  const doc = new DOMParser({ onError: () => { errors = true; } }).parseFromString(xml, 'application/xml');
  if (errors || !doc.documentElement) invalid();
  const nodes = doc.getElementsByTagName('*');
  if (nodes.length > 5000) invalid();
  const ids = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes.item(i);
    if (!node) invalid();
    for (let j = 0; j < node.attributes.length; j++) {
      const attr = node.attributes.item(j);
      if (!attr) invalid();
      if ((attr.localName ?? attr.name).toLowerCase() === 'id') {
        if (!attr.value || ids.has(attr.value)) invalid();
        ids.add(attr.value);
      }
    }
  }
  for (const [tag, allow] of [['SignatureMethod', STRONG_SIGNATURES], ['DigestMethod', STRONG_DIGESTS]] as const) {
    const methods = doc.getElementsByTagNameNS(DS, tag);
    for (let i = 0; i < methods.length; i++) if (!allow.has(methods.item(i)?.getAttribute('Algorithm') ?? '')) invalid();
  }
  return doc;
}

function cache(connectionId: string, db: Pick<Prisma.TransactionClient, 'orgSsoReplay'>): CacheProvider {
  return {
    async saveAsync(key, value) {
      await db.orgSsoReplay.create({ data: { key: `${connectionId}:${key}`, value,
        expiresAt: new Date(Date.now() + 900000) } });
      return { value, createdAt: Date.now() };
    },
    async getAsync(key) {
      const row = await db.orgSsoReplay.findUnique({ where: { key: `${connectionId}:${key}` } });
      return row && row.expiresAt > new Date() ? row.value : null;
    },
    async removeAsync(key) {
      if (!key) return null;
      // Expired records remain as replay tombstones until pruning, never recycled identifiers.
      const result = await db.orgSsoReplay.updateMany({ where: { key: `${connectionId}:${key}`,
        expiresAt: { gt: new Date() } }, data: { expiresAt: new Date(0) } });
      return result.count ? key : null;
    },
  };
}

async function connectionKeys(connection: OrgSsoConnection) {
  if (!connection.encryptedSecret) throw new AppError('BAD_REQUEST', 400, 'SSO_SP_KEY_REQUIRED');
  return z.object({ private_key: z.string().min(100), certificate: z.string().min(100),
    decryption_private_key: z.string().min(100).optional() }).strict().parse(JSON.parse(
    await openEnterpriseSecret(connection.encryptedSecret, `connection:${connection.id}`)));
}
async function engine(connection: OrgSsoConnection,
  db = getAdminPrisma() as Pick<Prisma.TransactionClient, 'orgSsoReplay'>, requestId?: string) {
  const config = SamlEnterpriseConfiguration.parse(connection.configuration);
  const keys = await connectionKeys(connection);
  const now = new Date();
  for (const pem of [...config.certificates, keys.certificate]) {
    const certificate = new X509Certificate(pem);
    const details = certificate.publicKey.asymmetricKeyDetails;
    if (certificate.publicKey.asymmetricKeyType !== 'rsa' || (details?.modulusLength ?? 0) < 2048 ||
      new Date(certificate.validFrom) > now || new Date(certificate.validTo) <= now) invalid();
  }
  const issuer = `${getPublicBaseUrl()}/sso/saml/${connection.id}`;
  return new SAML({ issuer, audience: issuer, callbackUrl: `${issuer}/acs`, entryPoint: config.sso_url,
    forceAuthn: config.force_authn === true,
    idpIssuer: config.entity_id, idpCert: config.certificates, privateKey: keys.private_key,
    publicCert: keys.certificate, decryptionPvk: keys.decryption_private_key,
    signatureAlgorithm: 'sha256', digestAlgorithm: 'sha256', wantAssertionsSigned: true,
    wantAuthnResponseSigned: true, validateInResponseTo: ValidateInResponseTo.always,
    acceptedClockSkewMs: 120000, maxAssertionAgeMs: 600000, requestIdExpirationPeriodMs: 600000,
    cacheProvider: cache(connection.id, db), identifierFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
    ...(requestId ? { generateUniqueId: () => requestId } : {}),
    disableRequestedAuthnContext: !config.authn_context,
    ...(config.authn_context ? { authnContext: [config.authn_context], racComparison: 'exact' as const } : {}),
  });
}

export async function enterpriseSamlAuthorize(connection: OrgSsoConnection, flow: OrgSsoFlow, db: Prisma.TransactionClient): Promise<string> {
  return (await engine(connection, db, `_${flow.id}`)).getAuthorizeUrlAsync(flow.id, undefined, {});
}
export async function enterpriseSamlMetadata(connection: OrgSsoConnection): Promise<string> {
  const issuer = `${getPublicBaseUrl()}/sso/saml/${connection.id}`;
  if (!connection.publicSigningCertificates.length) throw new AppError('BAD_REQUEST', 400, 'SSO_SP_KEY_REQUIRED');
  const keys = await connectionKeys(connection);
  return generateServiceProviderMetadata({ issuer, callbackUrl: `${issuer}/acs`,
    privateKey: keys.private_key, decryptionPvk: keys.decryption_private_key,
    signatureAlgorithm: 'sha256', digestAlgorithm: 'sha256',
    publicCerts: connection.publicSigningCertificates, decryptionCert: connection.publicSigningCertificates[0],
    wantAssertionsSigned: true, identifierFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent' });
}

export async function validateEnterpriseSamlCallback(connection: OrgSsoConnection, encoded: string,
  flowId: string): Promise<VerifiedEnterpriseIdentity> {
  if (encoded.length > 360000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid();
  const xml = Buffer.from(encoded, 'base64').toString('utf8');
  const outer = parseBoundedSaml(xml);
  const acs = `${getPublicBaseUrl()}/sso/saml/${connection.id}/acs`;
  if (outer.documentElement?.getAttribute('Destination') !== acs ||
    outer.documentElement.getAttribute('InResponseTo') !== `_${flowId}`) invalid();
  const assertions = outer.getElementsByTagNameNS(NS, 'Assertion');
  const encrypted = outer.getElementsByTagNameNS(NS, 'EncryptedAssertion');
  if (assertions.length + encrypted.length !== 1) invalid();
  const result = await (await engine(connection)).validatePostResponseAsync({ SAMLResponse: encoded });
  const profile = result.profile;
  if (!profile || result.loggedOut || !profile.getAssertionXml) invalid();
  const validatedXml = profile.getAssertionXml();
  const assertion = parseBoundedSaml(validatedXml);
  if (assertion.getElementsByTagNameNS(NS, 'Assertion').length !== 1) invalid();
  const config = SamlEnterpriseConfiguration.parse(connection.configuration);
  if (profile.issuer !== config.entity_id) invalid();
  const root = assertion.documentElement;
  if (!root) invalid();
  const id = root.getAttribute('ID');
  if (!id) invalid();
  const authn = assertion.getElementsByTagNameNS(NS, 'AuthnStatement');
  const confirmations = assertion.getElementsByTagNameNS(NS, 'SubjectConfirmationData');
  if (authn.length !== 1 || confirmations.length !== 1) invalid();
  const recipient = confirmations.item(0)?.getAttribute('Recipient');
  if (recipient !== acs || confirmations.item(0)?.getAttribute('InResponseTo') !== `_${flowId}`) invalid();
  const confirmationExpiry = new Date(confirmations.item(0)?.getAttribute('NotOnOrAfter') ?? '');
  if (!Number.isFinite(confirmationExpiry.getTime()) || confirmationExpiry.getTime() + 120000 <= Date.now()) invalid();
  const confirmation = assertion.getElementsByTagNameNS(NS, 'SubjectConfirmation').item(0);
  if (confirmation?.getAttribute('Method') !== 'urn:oasis:names:tc:SAML:2.0:cm:bearer') invalid();
  const authenticatedAt = new Date(authn.item(0)?.getAttribute('AuthnInstant') ?? '');
  const expires = new Date(authn.item(0)?.getAttribute('SessionNotOnOrAfter') ?? '');
  if (config.authn_context) {
    const contexts = assertion.getElementsByTagNameNS(NS, 'AuthnContextClassRef');
    if (contexts.length !== 1 || contexts.item(0)?.textContent !== config.authn_context) invalid();
  }
  if (!Number.isFinite(authenticatedAt.getTime()) || authenticatedAt.getTime() > Date.now() + 120000) invalid();
  const subject = config.subject_attribute ? profile[config.subject_attribute] : profile.nameID;
  if (!config.subject_attribute && profile.nameIDFormat !== 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent') invalid();
  if (typeof subject !== 'string' || !subject || subject.length > 256 || profile[config.tenant.attribute] !== config.tenant.value) invalid();
  const replayKey = `${connection.id}:assertion:${createHash('sha256').update(id).digest('hex')}`;
  try { await getAdminPrisma().orgSsoReplay.create({ data: { key: replayKey, value: '',
    expiresAt: new Date(Math.max(Date.now() + 900000, expires.getTime() || 0)) } }); }
  catch (error) { if ((error as { code?: string }).code === 'P2002') invalid(); throw error; }
  const rawEmail = config.email_attribute ? profile[config.email_attribute] : undefined;
  const email = typeof rawEmail === 'string' ? z.string().email().max(320).parse(rawEmail).toLowerCase() : undefined;
  const rawGroups = config.groups_attribute ? profile[config.groups_attribute] : undefined;
  const groups = z.array(z.string().min(1).max(256)).max(1000).parse(rawGroups === undefined ? [] :
    typeof rawGroups === 'string' ? [rawGroups] : rawGroups);
  return { groups: [...new Set(groups)], ...(email ? { email } : {}), issuer: config.entity_id, tenant: config.tenant.value, subject,
    emailVerified: Boolean(email), authenticatedAt, observedAt: new Date(),
    sessionExpiresAt: Number.isFinite(expires.getTime()) ? expires : new Date(Date.now() + 28800000), amr: [] };
}
