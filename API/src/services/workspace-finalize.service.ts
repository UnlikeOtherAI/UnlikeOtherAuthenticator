import type { PrismaClient } from '@prisma/client';

import { getAuthServiceIdentifier, requireEnv } from '../config/env.js';
import type { ClientConfig } from './config.service.js';
import { finalizeAuthenticatedUser } from './access-request-flow.service.js';
import { resolveTwoFaPolicy } from './twofactor-policy.service.js';
import { signTwoFaChallenge } from './twofactor-challenge.service.js';
import { startTwoFactorSetup, type TwoFactorSetupResult } from './twofactor-setup.service.js';

type FinalizeWithPolicyDeps = {
  policyPrisma?: PrismaClient;
  prisma?: PrismaClient;
  twoFaPolicyPrisma?: PrismaClient;
  workspacePrisma?: PrismaClient;
};

export type WorkspaceFinalizeOutcome =
  | { kind: 'twofa'; twofa_token: string }
  | { kind: 'twofa_enroll_required'; setup: TwoFactorSetupResult }
  | {
      kind: 'granted';
      finalResult: Awaited<ReturnType<typeof finalizeAuthenticatedUser>>;
    };

/**
 * Shared post-identity-verification finalization: resolve the effective 2FA policy for a user and
 * either (a) return a 2FA challenge / forced-enroll setup, exactly mirroring the existing
 * login.ts / social-callback branching, or (b) finalize and issue the (optionally workspace-scoped)
 * authorization code. Centralizing this means /auth/login, /auth/verify-code, and
 * /auth/select-team can't drift on 2FA-vs-scope ordering (Phase 3b Task 6/7).
 */
export async function finalizeWithTwoFaPolicy(
  params: {
    userId: string;
    twoFaEnabled: boolean;
    config: ClientConfig;
    configUrl: string;
    redirectUrl: string;
    rememberMe: boolean;
    requestAccess: boolean;
    authMethod: string;
    codeChallenge?: string;
    codeChallengeMethod?: 'S256';
    ip?: string | null;
    orgId?: string;
    teamId?: string;
  },
  deps?: FinalizeWithPolicyDeps,
): Promise<WorkspaceFinalizeOutcome> {
  const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
  const audience = getAuthServiceIdentifier();
  if ((params.orgId === undefined) !== (params.teamId === undefined)) {
    throw new Error('workspace scope requires both orgId and teamId');
  }
  const workspace =
    params.orgId === undefined ? {} : { orgId: params.orgId, teamId: params.teamId as string };

  // When workspace selection is transactional, use that transaction so a
  // freshly accepted invite's organisation policy is visible before commit.
  const twoFaPolicy = await resolveTwoFaPolicy(
    {
      config: params.config,
      userId: params.userId,
      orgId: params.orgId,
    },
    deps?.twoFaPolicyPrisma || deps?.policyPrisma || deps?.prisma
      ? { prisma: deps.twoFaPolicyPrisma ?? deps.policyPrisma ?? deps.prisma }
      : undefined,
  );

  if (twoFaPolicy !== 'OFF' && params.twoFaEnabled) {
    const twofa_token = await signTwoFaChallenge({
      userId: params.userId,
      domain: params.config.domain,
      configUrl: params.configUrl,
      redirectUrl: params.redirectUrl,
      authMethod: params.authMethod,
      rememberMe: params.rememberMe,
      requestAccess: params.requestAccess,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      ...workspace,
      sharedSecret: SHARED_SECRET,
      audience,
    });
    return { kind: 'twofa', twofa_token };
  }

  if (twoFaPolicy === 'REQUIRED') {
    const setup = await startTwoFactorSetup(
      {
        userId: params.userId,
        config: params.config,
        configUrl: params.configUrl,
        finalize: {
          authMethod: params.authMethod,
          redirectUrl: params.redirectUrl,
          rememberMe: params.rememberMe,
          requestAccess: params.requestAccess,
          codeChallenge: params.codeChallenge,
          codeChallengeMethod: params.codeChallengeMethod,
          ...workspace,
        },
      },
      deps?.prisma ? { prisma: deps.prisma } : undefined,
    );
    return { kind: 'twofa_enroll_required', setup };
  }

  const finalResult = await finalizeAuthenticatedUser(
    {
      userId: params.userId,
      config: params.config,
      configUrl: params.configUrl,
      redirectUrl: params.redirectUrl,
      rememberMe: params.rememberMe,
      requestAccess: params.requestAccess,
      authMethod: params.authMethod,
      twoFaCompleted: false,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      ip: params.ip,
      ...workspace,
    },
    deps?.prisma
      ? {
          prisma: deps.prisma,
          ...(deps.policyPrisma ? { policyPrisma: deps.policyPrisma } : {}),
          // Keep code/signature-continuation issuance in the caller's workspace
          // selection transaction. A replay collision can then roll back every
          // grant or invite mutation produced by the losing request.
          signatureDeps: {
            prisma: deps.prisma,
            workspacePrisma: deps.workspacePrisma ?? deps.prisma,
          },
          workspacePrisma: deps.workspacePrisma,
        }
      : undefined,
  );

  return { kind: 'granted', finalResult };
}
