import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getAuthServiceIdentifier, requireEnv } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { decryptTwoFaSecret } from '../../utils/twofa-secret.js';
import type { ClientConfig } from '../config.service.js';
import { resolveTwoFaPolicy } from '../twofactor-policy.service.js';
import { verifyTwoFactorForLogin } from '../twofactor-login.service.js';
import { startTwoFactorSetup } from '../twofactor-setup.service.js';
import { verifyTwoFaSetupToken } from '../twofactor-setup-token.service.js';
import { enrollTwoFactorForUser } from '../twofactor-enroll.service.js';

/** Password is reverified under the credential lock on every step. Setup is bound
 * to the entire validated authorization request, so it cannot be retargeted. */
export async function completePublicSecondFactor(input: {
  userId: string; credentialEpoch: number; twoFaEnabled: boolean;
  config: ClientConfig; context: Record<string, unknown>; code?: string; setupToken?: string;
}, prisma: PrismaClient) {
  const policy = await resolveTwoFaPolicy({ config: input.config, userId: input.userId }, { prisma });
  if (policy === 'OFF') return { completed: false };
  if (input.twoFaEnabled) {
    if (!input.code) return { response: { ok: true, twofa_required: true } };
    await verifyTwoFactorForLogin({ userId: input.userId, code: input.code }, { prisma });
    return { completed: true };
  }
  if (policy !== 'REQUIRED') return { completed: false };
  const configUrl = 'urn:uoa:public-setup:' + createHash('sha256')
    .update(JSON.stringify(Object.entries(input.context).sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex');
  if (!input.setupToken || !input.code) {
    const setup = await startTwoFactorSetup({ ...input, configUrl }, { prisma });
    return { response: { ok: true, twofa_enroll_required: true, ...setup } };
  }
  const sharedSecret = requireEnv('SHARED_SECRET').SHARED_SECRET;
  const setup = await verifyTwoFaSetupToken({
    token: input.setupToken, sharedSecret, audience: getAuthServiceIdentifier(),
  });
  if (setup.userId !== input.userId || setup.credentialEpoch !== input.credentialEpoch ||
      setup.domain !== input.config.domain || setup.configUrl !== configUrl) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }
  const totpSecret = decryptTwoFaSecret({ encryptedSecret: setup.encryptedSecret, sharedSecret });
  await enrollTwoFactorForUser({ userId: input.userId, totpSecret, code: input.code }, { prisma });
  return { completed: true };
}
