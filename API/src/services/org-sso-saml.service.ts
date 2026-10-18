import { createHash } from 'node:crypto';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { SAML, ValidateInResponseTo, generateServiceProviderMetadata, type CacheProvider } from '@node-saml/node-saml';
import { z } from 'zod';
import type { OrgSsoConnection, OrgSsoFlow, Prisma } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { getPublicBaseUrl } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { SamlEnterpriseConfiguration } from './org-sso-configuration.service.js';
import { enterpriseSamlKeySet } from './enterprise-saml-keys.service.js';
import { validateEnterpriseSigningCertificate } from './enterprise-signing-certificate.service.js';
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
    for (let i = 0; i < methods.length; i++) {
      const method = methods.item(i);
      const parent = method?.parentNode as { nodeType: number; localName?: string; namespaceURI?: string } | null;
      // RSA-OAEP's hash parameter is not a signature digest. SHA-1 OAEP remains distinct from forbidden SHA-1 signatures.
      if (tag === 'DigestMethod' && parent?.namespaceURI === 'http://www.w3.org/2001/04/xmlenc#' && parent.localName === 'EncryptionMethod') {
        if (!['http://www.w3.org/2000/09/xmldsig#sha1', 'http://www.w3.org/2000/09/xmldsig#sha256',
          'http://www.w3.org/2000/09/xmldsig#sha512'].includes(method?.getAttribute('Algorithm') ?? '')) invalid();
      } else if (!allow.has(method?.getAttribute('Algorithm') ?? '')) invalid();
    }
  }
  const encryption = doc.getElementsByTagNameNS('http://www.w3.org/2001/04/xmlenc#', 'EncryptionMethod');
  const allowedEncryption = new Set(['http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
    'http://www.w3.org/2001/04/xmlenc#aes128-cbc', 'http://www.w3.org/2001/04/xmlenc#aes256-cbc',
    'http://www.w3.org/2009/xmlenc11#aes128-gcm', 'http://www.w3.org/2009/xmlenc11#aes256-gcm']);
  for (let i = 0; i < encryption.length; i++) if (!allowedEncryption.has(encryption.item(i)?.getAttribute('Algorithm') ?? '')) invalid();
  return doc;
}

function cache(connectionId: string, db: Pick<Prisma.TransactionClient, 'orgSsoReplay'>, deferred?: Set<string>): CacheProvider {
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
      if (deferred) { deferred.add(key); return key; }
      // Expired records remain as replay tombstones until pruning, never recycled identifiers.
      const result = await db.orgSsoReplay.updateMany({ where: { key: `${connectionId}:${key}`,
        expiresAt: { gt: new Date() } }, data: { expiresAt: new Date(0) } });
      return result.count ? key : null;
    },
  };
}

async function engine(connection: OrgSsoConnection,
  db = getAdminPrisma() as Pick<Prisma.TransactionClient, 'orgSsoReplay'>, requestId?: string, decryptionKey?: string, deferred?: Set<string>) {
  const config = SamlEnterpriseConfiguration.parse(connection.configuration);
  const keys = (await enterpriseSamlKeySet(connection))[0];
  const certificates = config.certificates.filter((pem) => {
    try { validateEnterpriseSigningCertificate(pem); return true; } catch { return false; }
  });
  if (!certificates.length) invalid();
  const issuer = `${getPublicBaseUrl()}/sso/saml/${connection.id}`;
  return new SAML({ issuer, audience: issuer, callbackUrl: `${issuer}/acs`, entryPoint: config.sso_url,
    forceAuthn: config.force_authn === true,
    idpIssuer: config.entity_id, idpCert: certificates, privateKey: keys.private_key,
    publicCert: keys.certificate, decryptionPvk: decryptionKey ?? keys.decryption_private_key,
    signatureAlgorithm: 'sha256', digestAlgorithm: 'sha256', wantAssertionsSigned: true,
    wantAuthnResponseSigned: true, validateInResponseTo: ValidateInResponseTo.always,
    acceptedClockSkewMs: 120000, maxAssertionAgeMs: 600000, requestIdExpirationPeriodMs: 600000,
    cacheProvider: cache(connection.id, db, deferred), identifierFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
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
  const keySet = await enterpriseSamlKeySet(connection); const keys = keySet[0];
  const generate = (key: typeof keys) => generateServiceProviderMetadata({ issuer, callbackUrl: `${issuer}/acs`,
    privateKey: keys.private_key, decryptionPvk: key.decryption_private_key,
    signatureAlgorithm: 'sha256', digestAlgorithm: 'sha256',
    publicCerts: keySet.map((item) => item.certificate), decryptionCert: key.certificate,
    wantAssertionsSigned: true, identifierFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent' });
  const doc = parseBoundedSaml(generate(keys));
  if (keySet[1]) {
    const other = parseBoundedSaml(generate(keySet[1]));
    const descriptors = other.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:metadata', 'KeyDescriptor');
    for (let i = 0; i < descriptors.length; i++) {
      const descriptor = descriptors.item(i);
      if (descriptor?.getAttribute('use') === 'encryption') {
        const target = doc.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:metadata', 'SPSSODescriptor').item(0);
        const existing = target?.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:metadata', 'KeyDescriptor');
        if (!target || !existing?.length) invalid();
        target.insertBefore(doc.importNode(descriptor, true), existing.item(existing.length - 1)?.nextSibling ?? null);
      }
    }
  }
  return new XMLSerializer().serializeToString(doc);
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
  let result: Awaited<ReturnType<SAML['validatePostResponseAsync']>> | undefined;
  const keys = await enterpriseSamlKeySet(connection);
  const deferred = new Set<string>();
  try {
    for (const key of keys) {
      try { result = await (await engine(connection, undefined, undefined, key.decryption_private_key, deferred)).validatePostResponseAsync({ SAMLResponse: encoded }); break; }
      catch { /* Only two context-bound active decryption keys are attempted; full signature checks run for each. */ }
    }
  } finally {
    for (const key of deferred) if (!await cache(connection.id, getAdminPrisma()).removeAsync(key)) invalid();
  }
  if (!result) invalid();
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
