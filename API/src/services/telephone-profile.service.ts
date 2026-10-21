import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import {
  type TelephoneAuth, TelephoneNumber, TelephoneVisibility, telephoneDenied, telephoneDigest,
  telephoneLock, verifyTelephoneActor, lockTelephoneSubject,
} from './telephone-authority.service.js';

export type TelephoneAction = 'read' | 'set' | 'start' | 'verify' | 'remove' | 'visibility';
type Data = { number?: string; challengeId?: string; code?: string; visibility?: 'private' | 'team' };

/** All operations act only for the authenticated assertion subject. */
export async function telephoneProfile(input: TelephoneAuth & { action: TelephoneAction; data: Data },
  deps: { prisma?: PrismaClient; now?: () => Date; generateCode?: () => string } = {}) {
  const actor = await verifyTelephoneActor(input, `/apps/v1/nessie/phone-profile/${input.action}`);
  const result = await runInTransaction(deps.prisma ?? getAdminPrisma(), async tx => {
    await lockTelephoneSubject(tx, input, actor.exp, actor.tv);
    const userId = input.request.userId;
    const now = deps.now?.() ?? new Date();
    if (input.action === 'start') {
      const number = TelephoneNumber.parse(input.data.number);
      await telephoneLock(tx, telephoneDigest(number));
      const since = new Date(now.getTime() - 15 * 60_000);
      const [userCount, numberCount] = await Promise.all([
        tx.telephoneChallenge.count({ where: { userId, createdAt: { gt: since } } }),
        tx.telephoneChallenge.count({ where: { number, createdAt: { gt: since } } }),
      ]);
      if (userCount >= 5 || numberCount >= 5) throw new AppError('RATE_LIMITED', 429, 'RATE_LIMITED');
      const id = randomUUID();
      const code = deps.generateCode?.() ?? randomInt(0, 1_000_000).toString().padStart(6, '0');
      const expiresAt = new Date(now.getTime() + 5 * 60_000);
      await tx.telephoneChallenge.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
      await tx.telephoneChallenge.create({ data: { id, userId, appKeyId: input.credential.id,
        tokenVersion: actor.tv, number, codeHash: telephoneDigest(`${id}:${code}`), expiresAt, createdAt: now } });
      await tx.userTelephone.upsert({ where: { userId },
        create: { userId, pendingNumber: number }, update: { pendingNumber: number } });
      // This response is a delivery instruction for Nessie's trusted backend, never its browser.
      return { challengeId: id, expiresAt: expiresAt.toISOString(), delivery: { number, code } };
    }
    if (input.action === 'set') {
      const number = TelephoneNumber.parse(input.data.number);
      await tx.telephoneChallenge.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
      await tx.userTelephone.upsert({ where: { userId },
        create: { userId, pendingNumber: number }, update: { pendingNumber: number } });
    }
    if (input.action === 'verify') {
      const token = await tx.telephoneChallenge.findUnique({ where: { id: input.data.challengeId ?? '' } });
      if (!token || token.userId !== userId || token.appKeyId !== input.credential.id || token.tokenVersion !== actor.tv
        || token.usedAt || token.expiresAt <= now || token.attempts >= 5) return null;
      const profile = await tx.userTelephone.findUnique({ where: { userId } });
      if (profile?.pendingNumber !== token.number) return null;
      await tx.telephoneChallenge.update({ where: { id: token.id }, data: { attempts: { increment: 1 } } });
      const actual = Buffer.from(token.codeHash);
      const expected = Buffer.from(telephoneDigest(`${token.id}:${input.data.code ?? ''}`));
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      await tx.telephoneChallenge.update({ where: { id: token.id }, data: { usedAt: now } });
      await tx.userTelephone.upsert({ where: { userId },
        create: { userId, number: token.number, verifiedAt: now, visibility: 'private' },
        update: { number: token.number, pendingNumber: null, verifiedAt: now, visibility: 'private' } });
    }
    if (input.action === 'remove') {
      await tx.userTelephone.deleteMany({ where: { userId } });
      await tx.telephoneChallenge.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
    }
    if (input.action === 'visibility') {
      const visibility = TelephoneVisibility.parse(input.data.visibility);
      if ((await tx.userTelephone.updateMany({ where: { userId }, data: { visibility } })).count !== 1) throw telephoneDenied();
    }
    const phone = await tx.userTelephone.findUnique({ where: { userId }, select: { number: true, pendingNumber: true, visibility: true, verifiedAt: true } });
    return { phone: phone ? { ...phone, verifiedAt: phone.verifiedAt?.toISOString() ?? null } : null };
  });
  // Failed guesses commit before the generic refusal is emitted.
  if (!result) throw telephoneDenied();
  return result;
}
