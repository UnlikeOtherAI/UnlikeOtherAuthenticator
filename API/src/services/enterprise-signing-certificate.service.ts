import { X509Certificate } from 'node:crypto';
import { AppError } from '../utils/errors.js';

export function validateEnterpriseSigningCertificate(pem: string): X509Certificate {
  try {
    if (pem.length > 20000 || (pem.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0) !== 1) throw new Error('certificate shape');
    const certificate = new X509Certificate(pem);
    const modulus = certificate.publicKey.asymmetricKeyDetails?.modulusLength ?? 0;
    if (certificate.publicKey.asymmetricKeyType !== 'rsa' || modulus < 2048 || modulus > 8192 ||
      new Date(certificate.validFrom) > new Date() || new Date(certificate.validTo) <= new Date()) throw new Error('certificate policy');
    return certificate;
  } catch { throw new AppError('BAD_REQUEST', 400, 'SSO_SIGNING_CERTIFICATE_INVALID'); }
}
