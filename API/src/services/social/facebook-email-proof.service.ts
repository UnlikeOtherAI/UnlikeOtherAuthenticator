import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { LOGIN_CODE_MAX_ATTEMPTS, LOGIN_CODE_TTL_MS } from '../../config/constants.js';
import { getAuthServiceIdentifier, getEnv, requireEnv } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { hashEmailToken } from '../../utils/verification-token.js';
import type { ClientConfig } from '../config.service.js';
import { sendLoginCodeEmail } from '../email.service.js';
import { extractEmailTheme } from '../email-theme.service.js';
import { validateSocialProfile, type SocialProfile } from './provider.base.js';
import { generateSocialStateNonce } from './social-state-cookie.js';
import { signSocialState, type SocialState } from './social-state.service.js';

const COOKIE_NAME = 'uoa_facebook_email_proof';
const COOKIE_PATH = '/auth';
const PROOF_CODE_PREFIX = 'facebook-proof:';

type ProofPrisma = Pick<PrismaClient, 'facebookEmailProof'>;
export type FacebookProofCookie = { id: string; nonce: string };

function failed(): AppError {
  return new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
}

function hashScoped(value: string): string {
  return hashEmailToken(value, requireEnv('SHARED_SECRET').SHARED_SECRET);
}

function equalHash(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieOptions() {
  return { httpOnly: true, secure: true, sameSite: 'lax' as const, path: COOKIE_PATH, signed: true };
}

export function readFacebookProofCookie(request: FastifyRequest): FacebookProofCookie | null {
  const raw = request.cookies?.[COOKIE_NAME];
  if (typeof raw !== 'string') return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || typeof unsigned.value !== 'string') return null;
  try {
    const value: unknown = JSON.parse(unsigned.value);
    if (!value || typeof value !== 'object') return null;
    const { id, nonce } = value as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) ||
        typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return null;
    return { id, nonce };
  } catch {
    return null;
  }
}

export function clearFacebookProofCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: 0 });
}

export function facebookProofCode(id: string): string {
  return `${PROOF_CODE_PREFIX}${id}`;
}

export function parseFacebookProofCode(code: string): string | null {
  const id = code.startsWith(PROOF_CODE_PREFIX) ? code.slice(PROOF_CODE_PREFIX.length) : '';
  return /^[0-9a-f-]{36}$/.test(id) ? id : null;
}

export async function issueFacebookEmailProof(params: {
  profile: SocialProfile;
  state: SocialState;
  inviteToken: string | null;
  config: ClientConfig;
  prisma: ProofPrisma;
  reply: FastifyReply;
}): Promise<void> {
  if (!params.profile.providerSubject) throw failed();
  const id = randomUUID();
  const nonce = randomBytes(32).toString('base64url');
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const now = new Date();
  await params.prisma.facebookEmailProof.create({
    data: {
      id,
      email: params.profile.email,
      providerSubject: params.profile.providerSubject,
      name: params.profile.name,
      avatarUrl: params.profile.avatarUrl,
      stateJson: JSON.stringify(params.state),
      inviteToken: params.inviteToken,
      browserHash: hashScoped(`${id}:${nonce}`),
      codeHash: hashScoped(`${id}:${code}`),
      expiresAt: new Date(now.getTime() + LOGIN_CODE_TTL_MS),
    },
  });
  await sendLoginCodeEmail({ to: params.profile.email, code, theme: extractEmailTheme(params.config) });
  params.reply.setCookie(COOKIE_NAME, JSON.stringify({ id, nonce }), {
    ...cookieOptions(),
    maxAge: Math.floor(LOGIN_CODE_TTL_MS / 1000),
  });
}

async function loadProof(params: {
  cookie: FacebookProofCookie | null;
  prisma: ProofPrisma;
  requireVerified: boolean;
  completionStateJwt?: string;
}) {
  if (!params.cookie) throw failed();
  const proof = await params.prisma.facebookEmailProof.findUnique({ where: { id: params.cookie.id } });
  if (!proof || proof.usedAt || proof.expiresAt.getTime() <= Date.now() ||
      proof.attempts >= LOGIN_CODE_MAX_ATTEMPTS ||
      (params.requireVerified && !proof.verifiedAt) ||
      (params.completionStateJwt !== undefined && proof.completionStateJwt !== params.completionStateJwt) ||
      !equalHash(proof.browserHash, hashScoped(`${params.cookie.id}:${params.cookie.nonce}`))) {
    throw failed();
  }
  return proof;
}

export async function verifyFacebookEmailProof(params: {
  cookie: FacebookProofCookie | null;
  code: string;
  prisma: ProofPrisma;
}): Promise<{ stateJwt: string; nonce: string; inviteToken: string | null; id: string }> {
  const proof = await loadProof({ cookie: params.cookie, prisma: params.prisma, requireVerified: false });
  if (proof.verifiedAt) throw failed();
  const candidate = hashScoped(`${proof.id}:${params.code}`);
  if (!equalHash(proof.codeHash, candidate)) {
    await params.prisma.facebookEmailProof.updateMany({
      where: { id: proof.id, usedAt: null, verifiedAt: null, attempts: { lt: LOGIN_CODE_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    throw failed();
  }
  const state = JSON.parse(proof.stateJson) as SocialState;
  const nonce = generateSocialStateNonce();
  const env = getEnv();
  const baseUrl = (env.PUBLIC_BASE_URL ?? `http://${env.HOST}:${env.PORT}`).replace(/\/+$/, '');
  const stateJwt = await signSocialState({
    provider: 'facebook',
    configUrl: state.config_url,
    redirectUrl: state.redirect_url,
    state: state.state,
    managementOrgId: state.management_org_id,
    requestAccess: state.request_access,
    teamInvite: state.team_invite === true,
    codeChallenge: state.code_challenge,
    codeChallengeMethod: state.code_challenge_method,
    teamHint: state.team_hint,
    nonce,
    sharedSecret: requireEnv('SHARED_SECRET').SHARED_SECRET,
    audience: getAuthServiceIdentifier(),
    baseUrlForIssuer: baseUrl,
  });
  const updated = await params.prisma.facebookEmailProof.updateMany({
    where: {
      id: proof.id,
      browserHash: proof.browserHash,
      codeHash: proof.codeHash,
      usedAt: null,
      verifiedAt: null,
      attempts: { lt: LOGIN_CODE_MAX_ATTEMPTS },
      expiresAt: { gt: new Date() },
    },
    data: { verifiedAt: new Date(), completionStateJwt: stateJwt },
  });
  if (updated.count !== 1) throw failed();
  return { stateJwt, nonce, inviteToken: proof.inviteToken, id: proof.id };
}

export async function loadVerifiedFacebookProof(params: {
  id: string;
  stateJwt: string;
  cookie: FacebookProofCookie | null;
  prisma: ProofPrisma;
}): Promise<SocialProfile> {
  if (params.cookie?.id !== params.id) throw failed();
  const proof = await loadProof({
    cookie: params.cookie,
    prisma: params.prisma,
    requireVerified: true,
    completionStateJwt: params.stateJwt,
  });
  return validateSocialProfile({
    provider: 'facebook',
    providerSubject: proof.providerSubject,
    email: proof.email,
    emailVerified: true,
    name: proof.name,
    avatarUrl: proof.avatarUrl,
  });
}

export async function consumeFacebookEmailProof(params: {
  id: string;
  prisma: ProofPrisma;
}): Promise<void> {
  const updated = await params.prisma.facebookEmailProof.updateMany({
    where: { id: params.id, verifiedAt: { not: null }, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (updated.count !== 1) throw failed();
}
