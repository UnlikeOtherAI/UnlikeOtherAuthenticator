import { createHash, X509Certificate } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { SAML, ValidateInResponseTo, type CacheProvider } from '@node-saml/node-saml';
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

function engine(connection: OrgSsoConnection, db = getAdminPrisma() as Pick<Prisma.TransactionClient, 'orgSsoReplay'>) {
  const config = SamlEnterpriseConfiguration.parse(connection.configuration);
  if (!connection.encryptedSecret) throw new AppError('BAD_REQUEST', 400, 'SSO_SP_KEY_REQUIRED');
  const keys = z.object({ private_key: z.string().min(100), certificate: z.string().min(100),
    decryption_private_key: z.string().min(100).optional() }).strict().parse(JSON.parse(
    openEnterpriseSecret(connection.encryptedSecret, `connection:${connection.id}`)));
  const now = new Date();
  for (const pem of [...config.certificates, keys.certificate]) {
    const certificate = new X509Certificate(pem);
    const details = certificate.publicKey.asymmetricKeyDetails;
    if (certificate.publicKey.asymmetricKeyType !== 'rsa' || (details?.modulusLength ?? 0) < 2048 ||
      new Date(certificate.validFrom) > now || new Date(certificate.validTo) <= now) invalid();
  }
  const issuer = `${getPublicBaseUrl()}/sso/saml/${connection.id}`;
  return new SAML({ issuer, audience: issuer, callbackUrl: `${issuer}/acs`, entryPoint: config.sso_url,
    idpIssuer: config.entity_id, idpCert: config.certificates, privateKey: keys.private_key,
    publicCert: keys.certificate, decryptionPvk: keys.decryption_private_key,
    signatureAlgorithm: 'sha256', digestAlgorithm: 'sha256', wantAssertionsSigned: true,
    wantAuthnResponseSigned: true, validateInResponseTo: ValidateInResponseTo.always,
    acceptedClockSkewMs: 120000, maxAssertionAgeMs: 600000, requestIdExpirationPeriodMs: 600000,
    cacheProvider: cache(connection.id, db), identifierFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
    disableRequestedAuthnContext: !config.authn_context,
    ...(config.authn_context ? { authnContext: [config.authn_context], racComparison: 'exact' as const } : {}),
  });
}

export async function enterpriseSamlAuthorize(connection: OrgSsoConnection, flow: OrgSsoFlow, db: Prisma.TransactionClient): Promise<string> {
  return engine(connection, db).getAuthorizeUrlAsync(flow.id, undefined, {});
}
export function enterpriseSamlMetadata(connection: OrgSsoConnection): string {
  return engine(connection).generateServiceProviderMetadata(null, undefined);
}

export async function validateEnterpriseSamlCallback(connection: OrgSsoConnection, encoded: string): Promise<VerifiedEnterpriseIdentity> {
  if (encoded.length > 360000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid();
  const xml = Buffer.from(encoded, 'base64').toString('utf8');
  const outer = parseBoundedSaml(xml);
  const assertions = outer.getElementsByTagNameNS(NS, 'Assertion');
  const encrypted = outer.getElementsByTagNameNS(NS, 'EncryptedAssertion');
  if (assertions.length + encrypted.length !== 1) invalid();
  const result = await engine(connection).validatePostResponseAsync({ SAMLResponse: encoded });
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
  if (recipient !== `${getPublicBaseUrl()}/sso/saml/${connection.id}/acs`) invalid();
  const authenticatedAt = new Date(authn.item(0)?.getAttribute('AuthnInstant') ?? '');
  const expires = new Date(authn.item(0)?.getAttribute('SessionNotOnOrAfter') ?? '');
  if (!Number.isFinite(authenticatedAt.getTime()) || authenticatedAt.getTime() > Date.now() + 120000) invalid();
  const subject = config.subject_attribute ? profile[config.subject_attribute] : profile.nameID;
  if (!config.subject_attribute && profile.nameIDFormat !== 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent') invalid();
  if (typeof subject !== 'string' || !subject || subject.length > 256 || profile[config.tenant.attribute] !== config.tenant.value) invalid();
  const replayKey = `${connection.id}:assertion:${createHash('sha256').update(id).digest('hex')}`;
  try { await getAdminPrisma().orgSsoReplay.create({ data: { key: replayKey, value: '',
    expiresAt: new Date(Math.max(Date.now() + 900000, expires.getTime() || 0)) } }); }
  catch (error) { if ((error as { code?: string }).code === 'P2002') invalid(); throw error; }
  return { issuer: config.entity_id, tenant: config.tenant.value, subject,
    emailVerified: false, authenticatedAt, observedAt: new Date(),
    sessionExpiresAt: Number.isFinite(expires.getTime()) ? expires : new Date(Date.now() + 28800000), amr: [] };
}
