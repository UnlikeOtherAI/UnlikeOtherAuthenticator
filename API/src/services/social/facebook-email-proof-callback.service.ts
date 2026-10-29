import type { FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../config.service.js';
import { buildUserIdentity } from '../user-scope.service.js';
import { recordAuthIdentity } from '../auth-identity.service.js';
import { AppError } from '../../utils/errors.js';
import type { SocialProfile } from './provider.base.js';
import type { SocialState } from './social-state.service.js';
import {
  consumeFacebookEmailProof,
  issueFacebookEmailProof,
  loadVerifiedFacebookProof,
  type FacebookProofCookie,
} from './facebook-email-proof.service.js';

type FacebookPrisma = Pick<PrismaClient, 'user' | 'authIdentity' | 'facebookEmailProof'>;

export async function prepareFacebookProfile(params: {
  profile: SocialProfile | null;
  proofId: string | null;
  proofCookie: FacebookProofCookie | null;
  stateJwt: string;
  state: SocialState;
  inviteToken: string | null;
  config: ClientConfig;
  prisma: FacebookPrisma;
  reply: FastifyReply;
}): Promise<{ profile: SocialProfile; proofId: string | null } | null> {
  if (params.proofId) {
    const profile = await loadVerifiedFacebookProof({
      id: params.proofId,
      stateJwt: params.stateJwt,
      cookie: params.proofCookie,
      prisma: params.prisma,
    });
    return { profile, proofId: params.proofId };
  }
  const profile = params.profile;
  if (!profile?.providerSubject) throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  const { userKey } = buildUserIdentity({
    userScope: params.config.user_scope,
    email: profile.email,
    domain: params.config.domain,
  });
  const user = await params.prisma.user.findUnique({
    where: { lifecycleStatus: 'ACTIVE', userKey },
    select: { id: true },
  });
  const identity = user ? await params.prisma.authIdentity.findUnique({
    where: { userId_provider: { userId: user.id, provider: 'facebook' } },
    select: { providerSubject: true, email: true },
  }) : null;
  if (identity?.providerSubject === profile.providerSubject &&
      identity.email.toLowerCase() === profile.email.toLowerCase()) {
    return { profile: { ...profile, emailVerified: true }, proofId: null };
  }
  await issueFacebookEmailProof({
    profile,
    state: params.state,
    inviteToken: params.inviteToken,
    config: params.config,
    prisma: params.prisma,
    reply: params.reply,
  });
  return null;
}

export async function bindFacebookIdentity(params: {
  userId: string;
  profile: SocialProfile;
  proofId: string | null;
  prisma: FacebookPrisma;
}): Promise<void> {
  const subject = params.profile.providerSubject;
  if (!subject) throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  if (params.proofId) await consumeFacebookEmailProof({ id: params.proofId, prisma: params.prisma });
  const existing = await params.prisma.authIdentity.findUnique({
    where: { userId_provider: { userId: params.userId, provider: 'facebook' } },
    select: { providerSubject: true },
  });
  if (existing && existing.providerSubject !== subject && !params.proofId) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }
  await recordAuthIdentity({
    userId: params.userId,
    provider: 'facebook',
    providerSubject: subject,
    email: params.profile.email,
  }, { prisma: params.prisma });
}
