import 'reflect-metadata';
import { randomBytes, webcrypto } from 'node:crypto';
import { X509CertificateGenerator, KeyUsagesExtension, KeyUsageFlags } from '@peculiar/x509';
import { sealEnterpriseSecret } from './enterprise-secret.service.js';

/** Generated once for a stable SP. Trust-anchor overlap rotation is a separate explicit action. */
export async function createEnterpriseSpKey(connectionId: string) {
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256',
    modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
  const crypto = webcrypto as unknown as NonNullable<Parameters<typeof X509CertificateGenerator.createSelfSigned>[1]>;
  const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString('hex'), name: `CN=UOA SAML ${connectionId}`,
    notBefore: new Date(Date.now() - 60000), notAfter: new Date(Date.now() + 365 * 86400000),
    signingAlgorithm: algorithm, keys,
    extensions: [new KeyUsagesExtension(KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment, true)],
  }, crypto);
  const privateKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  const encoded = privateKey.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  const pem = `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
  const publicCertificate = certificate.toString('pem');
  try {
    return { publicCertificate, encryptedSecret: await sealEnterpriseSecret(JSON.stringify({ private_key: pem,
      certificate: publicCertificate, decryption_private_key: pem }), `connection:${connectionId}`) };
  } finally { privateKey.fill(0); }
}
