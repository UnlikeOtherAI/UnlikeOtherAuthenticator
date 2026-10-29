import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { getAuthServiceIdentifier, getEnv, requireEnv } from '../../src/config/env.js';
import { hashEmailToken } from '../../src/utils/verification-token.js';
import {
  consumeFacebookEmailProof,
  loadVerifiedFacebookProof,
  verifyFacebookEmailProof,
} from '../../src/services/social/facebook-email-proof.service.js';
import { verifySocialState } from '../../src/services/social/social-state.service.js';

const id = '5dc768ab-0edb-46f6-b6d8-54ef59004166';
const nonce = 'a'.repeat(43);
const hash = (value: string) => hashEmailToken(value, requireEnv('SHARED_SECRET').SHARED_SECRET);

function proofStore() {
  const row = {
    id,
    email: 'person@example.com',
    providerSubject: 'facebook-123',
    name: 'Person',
    avatarUrl: null,
    stateJson: JSON.stringify({
      provider: 'facebook',
      config_url: 'https://client.example.com/config',
      redirect_url: 'https://client.example.com/callback',
      nonce: 'original-nonce',
    }),
    completionStateJwt: null as string | null,
    inviteToken: null,
    browserHash: hash(`${id}:${nonce}`),
    codeHash: hash(`${id}:123456`),
    attempts: 0,
    verifiedAt: null as Date | null,
    usedAt: null as Date | null,
    expiresAt: new Date(Date.now() + 60_000),
  };
  const prisma = {
    facebookEmailProof: {
      findUnique: async () => row,
      updateMany: async ({ where, data }: {
        where: { id: string; browserHash?: string; codeHash?: string; verifiedAt?: null | { not: null }; usedAt?: null; attempts?: { lt: number }; expiresAt?: { gt: Date } };
        data: { attempts?: { increment: number }; verifiedAt?: Date; completionStateJwt?: string; usedAt?: Date };
      }) => {
        if (where.id !== row.id || (where.browserHash && where.browserHash !== row.browserHash) ||
            (where.codeHash && where.codeHash !== row.codeHash) ||
            (where.verifiedAt === null && row.verifiedAt) ||
            (where.verifiedAt !== null && typeof where.verifiedAt === 'object' && !row.verifiedAt) ||
            (where.usedAt === null && row.usedAt) ||
            (where.attempts && row.attempts >= where.attempts.lt) ||
            (where.expiresAt && row.expiresAt <= where.expiresAt.gt)) return { count: 0 };
        if (data.attempts) row.attempts += data.attempts.increment;
        if (data.verifiedAt) row.verifiedAt = data.verifiedAt;
        if (data.completionStateJwt) row.completionStateJwt = data.completionStateJwt;
        if (data.usedAt) row.usedAt = data.usedAt;
        return { count: 1 };
      },
    },
  } as unknown as Pick<PrismaClient, 'facebookEmailProof'>;
  return { row, prisma };
}

describe('Facebook email proof', () => {
  it('is bound to the initiating browser and locks after five wrong codes', async () => {
    const { row, prisma } = proofStore();
    await expect(verifyFacebookEmailProof({ cookie: { id, nonce: 'b'.repeat(43) }, code: '123456', prisma }))
      .rejects.toThrow();
    expect(row.attempts).toBe(0);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(verifyFacebookEmailProof({ cookie: { id, nonce }, code: '000000', prisma }))
        .rejects.toThrow();
      expect(row.attempts).toBe(attempt);
    }
    await expect(verifyFacebookEmailProof({ cookie: { id, nonce }, code: '123456', prisma }))
      .rejects.toThrow();
  });

  it('renews signed state, binds the verified profile, and consumes proof once', async () => {
    const { prisma } = proofStore();
    const completed = await verifyFacebookEmailProof({ cookie: { id, nonce }, code: '123456', prisma });
    const state = await verifySocialState({
      stateJwt: completed.stateJwt,
      sharedSecret: requireEnv('SHARED_SECRET').SHARED_SECRET,
      audience: getAuthServiceIdentifier(),
      issuer: `${(getEnv().PUBLIC_BASE_URL ?? `http://${getEnv().HOST}:${getEnv().PORT}`).replace(/\/+$/, '')}/social-state`,
    });
    expect(state).toMatchObject({ provider: 'facebook', nonce: completed.nonce });
    await expect(loadVerifiedFacebookProof({ id, stateJwt: `${completed.stateJwt}tampered`, cookie: { id, nonce }, prisma }))
      .rejects.toThrow();
    const profile = await loadVerifiedFacebookProof({ id, stateJwt: completed.stateJwt, cookie: { id, nonce }, prisma });
    expect(profile).toMatchObject({ email: 'person@example.com', emailVerified: true, providerSubject: 'facebook-123' });
    await consumeFacebookEmailProof({ id, prisma });
    await expect(consumeFacebookEmailProof({ id, prisma })).rejects.toThrow();
  });
});
