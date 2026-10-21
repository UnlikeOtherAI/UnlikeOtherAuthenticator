import type { OrgSsoConnection } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { openEnterpriseSecret } from './enterprise-secret.service.js';
import { validateEnterpriseSigningCertificate } from './enterprise-signing-certificate.service.js';

const Keys = z.object({ private_key: z.string().min(100), certificate: z.string().min(100),
  decryption_private_key: z.string().min(100).optional() }).strict();
export async function enterpriseSamlKeySet(connection: OrgSsoConnection) {
  if (!connection.encryptedSecret) throw new AppError('BAD_REQUEST', 400, 'SSO_SP_KEY_REQUIRED');
  const load = async (sealed: string) => Keys.parse(JSON.parse(await openEnterpriseSecret(sealed, `connection:${connection.id}`)));
  const current = await load(connection.encryptedSecret);
  validateEnterpriseSigningCertificate(current.certificate);
  const keys = [current];
  if (connection.keyOverlapExpiresAt && connection.keyOverlapExpiresAt > new Date()) {
    const overlap = connection.encryptedNextSecret ?? connection.encryptedPreviousSecret;
    if (overlap) {
      const other = await load(overlap);
      validateEnterpriseSigningCertificate(other.certificate);
      keys.push(other);
    }
  }
  return keys;
}
