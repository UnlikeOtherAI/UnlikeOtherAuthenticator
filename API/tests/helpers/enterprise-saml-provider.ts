import { randomUUID, createPublicKey } from 'node:crypto';
import { SignedXml } from 'xml-crypto';
import { encrypt, type EncryptOptions } from 'xml-encryption';

const NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol';
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
type SigningKey = { private_key: string; certificate: string };
function sign(xml: string, type: 'Assertion' | 'Response', key: SigningKey) {
  const signer = new SignedXml({ privateKey: key.private_key, publicCert: key.certificate,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  signer.addReference({ xpath: `/*[local-name()='${type}']`, digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'] });
  signer.computeSignature(xml, { location: { reference: `/*[local-name()='${type}']/*[local-name()='Issuer']`, action: 'after' } });
  return signer.getSignedXml();
}

/** An actual cryptographic IdP fixture. It grants no runtime authentication override. */
export async function signedSamlResponse(input: { flowId: string; acs: string; audience: string; issuer: string; key: SigningKey;
  tenant?: string; subject?: string; assertionId?: string; recipient?: string; encryptForCertificate?: string }) {
  const now = new Date(); const expiry = new Date(now.getTime() + 300000).toISOString();
  const assertionId = input.assertionId ?? `_${randomUUID()}`;
  let assertion = sign(`<saml:Assertion xmlns:saml="${NS}" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    ID="${escape(assertionId)}" Version="2.0" IssueInstant="${now.toISOString()}"><saml:Issuer>${escape(input.issuer)}</saml:Issuer>
    <saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${escape(input.subject ?? 'stable-subject')}</saml:NameID>
    <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData
      InResponseTo="_${escape(input.flowId)}" Recipient="${escape(input.recipient ?? input.acs)}" NotOnOrAfter="${expiry}"/></saml:SubjectConfirmation></saml:Subject>
    <saml:Conditions NotBefore="${new Date(now.getTime() - 60000).toISOString()}" NotOnOrAfter="${expiry}">
      <saml:AudienceRestriction><saml:Audience>${escape(input.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${new Date(now.getTime() - 30000).toISOString()}" SessionIndex="session"
      SessionNotOnOrAfter="${new Date(now.getTime() + 3600000).toISOString()}"><saml:AuthnContext>
      <saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef>
      </saml:AuthnContext></saml:AuthnStatement>
    <saml:AttributeStatement><saml:Attribute Name="tenant"><saml:AttributeValue xsi:type="xs:string">${escape(input.tenant ?? 'exact-tenant')}</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="email"><saml:AttributeValue xsi:type="xs:string">person@corporate.example.com</saml:AttributeValue></saml:Attribute>
    </saml:AttributeStatement></saml:Assertion>`, 'Assertion', input.key);
  if (input.encryptForCertificate) {
    const options: EncryptOptions & { keyEncryptionDigest: string } = { pem: input.encryptForCertificate,
      rsa_pub: createPublicKey(input.encryptForCertificate).export({ type: 'spki', format: 'pem' }),
      encryptionAlgorithm: 'http://www.w3.org/2009/xmlenc11#aes256-gcm',
      keyEncryptionAlgorithm: 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p', keyEncryptionDigest: 'sha256',
      disallowEncryptionWithInsecureAlgorithm: true, warnInsecureAlgorithm: false };
    const encrypted = await new Promise<string>((resolve, reject) => encrypt(assertion, options,
      (error, value) => error ? reject(error) : resolve(value)));
    assertion = `<saml:EncryptedAssertion xmlns:saml="${NS}">${encrypted}</saml:EncryptedAssertion>`;
  }
  const response = sign(`<samlp:Response xmlns:samlp="${PROTOCOL}" xmlns:saml="${NS}" ID="_${randomUUID()}" Version="2.0"
    IssueInstant="${now.toISOString()}" Destination="${escape(input.acs)}" InResponseTo="_${escape(input.flowId)}">
    <saml:Issuer>${escape(input.issuer)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
    ${assertion}</samlp:Response>`, 'Response', input.key);
  return Buffer.from(response).toString('base64');
}
