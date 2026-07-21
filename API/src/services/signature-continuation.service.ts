import { createHmac, randomBytes } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import { getEnv, getPublicBaseUrl, requireEnv, type Env } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { buildRedirectToUrl, issueAuthorizationCode } from './authorization-code.service.js';
import { issueOAuthCode, type IssueOAuthCodeInput } from './oauth/oauth-code.service.js';
import { evaluateSignaturePolicy } from './signature-policy.service.js';

type ConfigCodeIssuer = typeof issueAuthorizationCode;
type PublicCodeIssuer = typeof issueOAuthCode;

export type SignatureContinuationDeps = {
  env?: Env;
  issueConfigCode?: ConfigCodeIssuer;
  issuePublicCode?: PublicCodeIssuer;
  now?: () => Date;
  prisma?: PrismaClient;
  /** BYPASSRLS client for centrally bound product workspace policy/membership reads. */
  workspacePrisma?: PrismaClient;
  publicBaseUrl?: string;
  sharedSecret?: string;
};

export type SignatureGateOutcome =
  | { status: 'granted'; code: string; redirectTo: string }
  | {
      status: 'signing_required';
      signingToken: string;
      redirectTo: string;
      policyRevision: number;
    };

type ConfigGateInput = {
  userId: string;
  domain: string;
  configUrl: string;
  redirectUrl: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  rememberMe: boolean;
  requestAccess: boolean;
  orgId?: string;
  teamId?: string;
  authMethod: string;
  twoFaCompleted: boolean;
};

export type PublicOAuthGateInput = {
  userId: string;
  domain: string;
  oauthClientId: string;
  redirectUrl: string;
  resource?: string;
  state?: string;
  scope?: string;
  codeChallenge: string;
  rememberMe: boolean;
  authMethod: string;
  twoFaCompleted: boolean;
};

function continuationPrisma(deps?: SignatureContinuationDeps): PrismaClient {
  return deps?.prisma ?? getAdminPrisma();
}

function continuationEnv(deps?: SignatureContinuationDeps): Env {
  return deps?.env ?? getEnv();
}

function sharedSecret(deps?: SignatureContinuationDeps): string {
  return deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
}

function currentTime(deps?: SignatureContinuationDeps): Date {
  return deps?.now?.() ?? new Date();
}

function rejectContinuation(): never {
  throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
}

function requirePkce(params: { codeChallenge?: string; codeChallengeMethod?: string }): {
  codeChallenge: string;
  codeChallengeMethod: 'S256';
} {
  if (!params.codeChallenge || params.codeChallengeMethod !== 'S256') {
    throw new AppError('BAD_REQUEST', 400, 'PKCE_REQUIRED');
  }
  return { codeChallenge: params.codeChallenge, codeChallengeMethod: 'S256' };
}

export function hashSigningContinuationToken(token: string, pepper: string): string {
  return createHmac('sha256', pepper)
    .update('uoa-signing-continuation\0', 'utf8')
    .update(token, 'utf8')
    .digest('hex');
}

function newSigningToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function lockSignaturePolicyForDecision(
  prisma: PrismaClient,
  domain: string,
): Promise<void> {
  await prisma.$executeRaw(
    Prisma.sql`SELECT 1 FROM "domain_signature_settings" WHERE "domain" = ${domain} FOR UPDATE`,
  );
}

async function lockContinuation(prisma: PrismaClient, tokenHash: string): Promise<void> {
  await prisma.$executeRaw(
    Prisma.sql`SELECT 1 FROM "signing_continuations" WHERE "token_hash" = ${tokenHash} FOR UPDATE`,
  );
}

export async function requireActiveSigningContinuation(
  params: { signingToken: string; lock?: boolean },
  deps?: SignatureContinuationDeps & { prisma: PrismaClient },
) {
  const prisma = deps?.prisma ?? continuationPrisma(deps);
  const env = continuationEnv(deps);
  const now = currentTime(deps);
  const tokenHash = hashSigningContinuationToken(params.signingToken, sharedSecret(deps));
  if (params.lock) await lockContinuation(prisma, tokenHash);
  const continuation = await prisma.signingContinuation.findUnique({ where: { tokenHash } });
  if (
    !continuation ||
    continuation.consumedAt ||
    continuation.expiresAt.getTime() <= now.getTime() ||
    continuation.attemptCount >= env.SIGNATURE_MAX_SIGN_ATTEMPTS
  ) {
    return rejectContinuation();
  }
  return continuation;
}

export async function recordSigningContinuationFailure(
  continuationId: string,
  deps?: SignatureContinuationDeps & { prisma: PrismaClient },
): Promise<void> {
  const prisma = deps?.prisma ?? continuationPrisma(deps);
  await prisma.signingContinuation.updateMany({
    where: { id: continuationId, consumedAt: null },
    data: { attemptCount: { increment: 1 } },
  });
}

function configSigningUrl(
  token: string,
  configUrl: string,
  deps?: SignatureContinuationDeps,
): string {
  const url = new URL('/auth', deps?.publicBaseUrl ?? getPublicBaseUrl(continuationEnv(deps)));
  url.searchParams.set('config_url', configUrl);
  url.searchParams.set('flow', 'signatures');
  url.searchParams.set('signing_token', token);
  return url.toString();
}

function publicSigningUrl(
  token: string,
  input: PublicOAuthGateInput,
  deps?: SignatureContinuationDeps,
): string {
  const url = new URL(
    '/oauth/authorize',
    deps?.publicBaseUrl ?? getPublicBaseUrl(continuationEnv(deps)),
  );
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.oauthClientId);
  url.searchParams.set('redirect_uri', input.redirectUrl);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('flow', 'signatures');
  url.searchParams.set('signing_token', token);
  if (input.state) url.searchParams.set('state', input.state);
  if (input.resource) url.searchParams.set('resource', input.resource);
  if (input.scope) url.searchParams.set('scope', input.scope);
  return url.toString();
}

async function createContinuation(
  params: ConfigGateInput | PublicOAuthGateInput,
  profile: 'CONFIG_JWT' | 'PUBLIC_OAUTH',
  policyRevision: number,
  tx: PrismaClient,
  deps?: SignatureContinuationDeps,
): Promise<{ token: string; redirectTo: string }> {
  const now = currentTime(deps);
  const env = continuationEnv(deps);
  const token = newSigningToken();
  const configInput = profile === 'CONFIG_JWT' ? (params as ConfigGateInput) : null;
  const publicInput = profile === 'PUBLIC_OAUTH' ? (params as PublicOAuthGateInput) : null;
  await tx.signingContinuation.create({
    data: {
      tokenHash: hashSigningContinuationToken(token, sharedSecret(deps)),
      userId: params.userId,
      domain: normalizeDomain(params.domain),
      authProfile: profile,
      configUrl: configInput?.configUrl ?? null,
      redirectUrl: params.redirectUrl,
      oauthState: publicInput?.state ?? null,
      oauthClientId: publicInput?.oauthClientId ?? null,
      oauthScope: publicInput?.scope ?? null,
      resource: publicInput?.resource ?? null,
      codeChallenge: params.codeChallenge ?? '',
      codeChallengeMethod: 'S256',
      rememberMe: params.rememberMe,
      requestAccess: configInput?.requestAccess ?? false,
      orgId: configInput?.orgId ?? null,
      teamId: configInput?.teamId ?? null,
      authMethod: params.authMethod,
      twoFaCompleted: params.twoFaCompleted,
      policyRevision,
      expiresAt: new Date(now.getTime() + env.SIGNATURE_CONTINUATION_TTL_MINUTES * 60_000),
      createdAt: now,
    },
  });
  return {
    token,
    redirectTo: configInput
      ? configSigningUrl(token, configInput.configUrl, deps)
      : publicSigningUrl(token, publicInput as PublicOAuthGateInput, deps),
  };
}

export async function finalizeConfigAuthorizationWithSignatures(
  input: ConfigGateInput,
  deps?: SignatureContinuationDeps,
): Promise<SignatureGateOutcome> {
  const pkce = requirePkce(input);
  const domain = normalizeDomain(input.domain);
  const prisma = continuationPrisma(deps);
  return runInTransaction(prisma, async (tx) => {
    await lockSignaturePolicyForDecision(tx, domain);
    const policy = await evaluateSignaturePolicy(
      { domain, userId: input.userId, now: currentTime(deps) },
      { prisma: tx },
    );
    if (policy.complete) {
      const issued = await (deps?.issueConfigCode ?? issueAuthorizationCode)(
        {
          ...input,
          ...pkce,
          domain,
          twoFaCompleted: input.twoFaCompleted,
        },
        {
          crossProductPrisma: deps?.workspacePrisma ?? tx,
          policyPrisma: deps?.workspacePrisma ?? tx,
          prisma: tx,
          now: deps?.now,
          sharedSecret: sharedSecret(deps),
        },
      );
      return {
        status: 'granted',
        code: issued.code,
        redirectTo: buildRedirectToUrl({ redirectUrl: input.redirectUrl, code: issued.code }),
      };
    }
    const continuation = await createContinuation(
      { ...input, ...pkce, domain },
      'CONFIG_JWT',
      policy.policyRevision,
      tx,
      deps,
    );
    return {
      status: 'signing_required',
      signingToken: continuation.token,
      redirectTo: continuation.redirectTo,
      policyRevision: policy.policyRevision,
    };
  });
}

export async function finalizePublicOAuthAuthorizationWithSignatures(
  input: PublicOAuthGateInput,
  deps?: SignatureContinuationDeps,
): Promise<SignatureGateOutcome> {
  const pkce = requirePkce({ codeChallenge: input.codeChallenge, codeChallengeMethod: 'S256' });
  const domain = normalizeDomain(input.domain);
  const prisma = continuationPrisma(deps);
  return runInTransaction(prisma, async (tx) => {
    await lockSignaturePolicyForDecision(tx, domain);
    const policy = await evaluateSignaturePolicy(
      { domain, userId: input.userId, now: currentTime(deps) },
      { prisma: tx },
    );
    if (policy.complete) {
      const issueInput: IssueOAuthCodeInput = {
        userId: input.userId,
        domain,
        oauthClientId: input.oauthClientId,
        redirectUrl: input.redirectUrl,
        resource: input.resource,
        scope: input.scope,
        state: input.state,
        codeChallenge: pkce.codeChallenge,
        rememberMe: input.rememberMe,
      };
      const issued = await (deps?.issuePublicCode ?? issueOAuthCode)(
        issueInput,
        tx as unknown as Prisma.TransactionClient,
        currentTime(deps),
      );
      return {
        status: 'granted',
        code: issued.code,
        redirectTo: publicCodeRedirect(input, issued.code),
      };
    }
    const continuation = await createContinuation(
      { ...input, ...pkce, domain },
      'PUBLIC_OAUTH',
      policy.policyRevision,
      tx,
      deps,
    );
    return {
      status: 'signing_required',
      signingToken: continuation.token,
      redirectTo: continuation.redirectTo,
      policyRevision: policy.policyRevision,
    };
  });
}

function publicCodeRedirect(
  input: Pick<PublicOAuthGateInput, 'redirectUrl' | 'state'>,
  code: string,
): string {
  const url = new URL(input.redirectUrl);
  url.searchParams.set('code', code);
  if (input.state) url.searchParams.set('state', input.state);
  return url.toString();
}

export async function completeSigningContinuation(
  signingToken: string,
  deps?: SignatureContinuationDeps,
): Promise<SignatureGateOutcome> {
  const prisma = continuationPrisma(deps);
  return runInTransaction(prisma, async (tx) => {
    const continuation = await requireActiveSigningContinuation(
      { signingToken, lock: true },
      { ...deps, prisma: tx },
    );
    await lockSignaturePolicyForDecision(tx, continuation.domain);
    const policy = await evaluateSignaturePolicy(
      { domain: continuation.domain, userId: continuation.userId, now: currentTime(deps) },
      { prisma: tx },
    );
    if (!policy.complete) {
      return {
        status: 'signing_required',
        signingToken,
        redirectTo:
          continuation.authProfile === 'CONFIG_JWT'
            ? configSigningUrl(signingToken, continuation.configUrl ?? rejectContinuation(), deps)
            : publicSigningUrl(signingToken, continuationToPublicInput(continuation), deps),
        policyRevision: policy.policyRevision,
      };
    }
    const consumedAt = currentTime(deps);
    const consumed = await tx.signingContinuation.updateMany({
      where: { id: continuation.id, consumedAt: null, expiresAt: { gt: consumedAt } },
      data: { consumedAt },
    });
    if (consumed.count !== 1) return rejectContinuation();

    if (continuation.authProfile === 'CONFIG_JWT') {
      if (!continuation.configUrl) return rejectContinuation();
      const issued = await (deps?.issueConfigCode ?? issueAuthorizationCode)(
        {
          userId: continuation.userId,
          domain: continuation.domain,
          configUrl: continuation.configUrl,
          redirectUrl: continuation.redirectUrl,
          codeChallenge: continuation.codeChallenge,
          codeChallengeMethod: 'S256',
          rememberMe: continuation.rememberMe,
          twoFaCompleted: continuation.twoFaCompleted,
          orgId: continuation.orgId ?? undefined,
          teamId: continuation.teamId ?? undefined,
        },
        {
          crossProductPrisma: deps?.workspacePrisma ?? tx,
          policyPrisma: deps?.workspacePrisma ?? tx,
          prisma: tx,
          now: deps?.now,
          sharedSecret: sharedSecret(deps),
        },
      );
      return {
        status: 'granted',
        code: issued.code,
        redirectTo: buildRedirectToUrl({
          redirectUrl: continuation.redirectUrl,
          code: issued.code,
        }),
      };
    }

    const publicInput = continuationToPublicInput(continuation);
    const issued = await (deps?.issuePublicCode ?? issueOAuthCode)(
      {
        userId: continuation.userId,
        domain: continuation.domain,
        oauthClientId: publicInput.oauthClientId,
        redirectUrl: continuation.redirectUrl,
        resource: publicInput.resource,
        scope: publicInput.scope,
        state: publicInput.state,
        codeChallenge: continuation.codeChallenge,
        rememberMe: continuation.rememberMe,
      },
      tx as unknown as Prisma.TransactionClient,
      consumedAt,
    );
    return {
      status: 'granted',
      code: issued.code,
      redirectTo: publicCodeRedirect(publicInput, issued.code),
    };
  });
}

function continuationToPublicInput(continuation: {
  userId: string;
  domain: string;
  oauthClientId: string | null;
  redirectUrl: string;
  resource: string | null;
  oauthState: string | null;
  oauthScope: string | null;
  codeChallenge: string;
  rememberMe: boolean;
  authMethod: string;
  twoFaCompleted: boolean;
}): PublicOAuthGateInput {
  if (!continuation.oauthClientId) return rejectContinuation();
  return {
    userId: continuation.userId,
    domain: continuation.domain,
    oauthClientId: continuation.oauthClientId,
    redirectUrl: continuation.redirectUrl,
    resource: continuation.resource ?? undefined,
    state: continuation.oauthState ?? undefined,
    scope: continuation.oauthScope ?? undefined,
    codeChallenge: continuation.codeChallenge,
    rememberMe: continuation.rememberMe,
    authMethod: continuation.authMethod,
    twoFaCompleted: continuation.twoFaCompleted,
  };
}
