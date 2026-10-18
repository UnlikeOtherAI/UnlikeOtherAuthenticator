import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { parseBoundedSaml } from './org-sso-saml.service.js';
import { validateEnterpriseSigningCertificate } from './enterprise-signing-certificate.service.js';

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
function invalid(): never { throw new AppError('BAD_REQUEST', 400, 'SSO_METADATA_INVALID'); }

/** Owner-pasted metadata is configuration input, never a network fetch or automatic trust decision. */
export function parseEnterpriseIdpMetadata(xml: string) {
  let doc: ReturnType<typeof parseBoundedSaml>;
  try { doc = parseBoundedSaml(xml); } catch { invalid(); }
  const root = doc.documentElement;
  if (!root || root.namespaceURI !== MD || root.localName !== 'EntityDescriptor' ||
    doc.getElementsByTagNameNS(MD, 'EntityDescriptor').length !== 1 ||
    doc.getElementsByTagNameNS(MD, 'IDPSSODescriptor').length !== 1) invalid();
  const entityId = z.string().min(1).max(1000).parse(root.getAttribute('entityID'));
  const descriptor = doc.getElementsByTagNameNS(MD, 'IDPSSODescriptor').item(0);
  if (!descriptor || descriptor.parentNode !== root ||
    !descriptor.getAttribute('protocolSupportEnumeration')?.split(/\s+/).includes('urn:oasis:names:tc:SAML:2.0:protocol')) invalid();
  const endpoints = descriptor.getElementsByTagNameNS(MD, 'SingleSignOnService');
  const locations = new Set<string>();
  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints.item(i);
    if (endpoint?.parentNode !== descriptor || endpoint.getAttribute('Binding') !== 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect') continue;
    const value = endpoint.getAttribute('Location');
    if (!value) invalid();
    const url = new URL(z.string().url().max(2048).parse(value));
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) invalid();
    locations.add(value);
  }
  if (locations.size !== 1) invalid();
  const certificates = new Map<string, string>();
  const keys = descriptor.getElementsByTagNameNS(MD, 'KeyDescriptor');
  for (let i = 0; i < keys.length; i++) {
    const key = keys.item(i);
    if (!key || key.parentNode !== descriptor || (key.hasAttribute('use') && key.getAttribute('use') !== 'signing')) continue;
    const nodes = key.getElementsByTagNameNS(DS, 'X509Certificate');
    for (let j = 0; j < nodes.length; j++) {
      const encoded = nodes.item(j)?.textContent?.replace(/\s/g, '') ?? '';
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 18000) invalid();
      const pem = `-----BEGIN CERTIFICATE-----\n${encoded.match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----`;
      const certificate = validateEnterpriseSigningCertificate(pem);
      certificates.set(certificate.fingerprint256, pem);
    }
  }
  if (!certificates.size || certificates.size > 3) invalid();
  return { entity_id: entityId, sso_url: [...locations][0], certificates: [...certificates.values()] };
}
