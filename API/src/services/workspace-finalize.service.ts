import type { PrismaClient } from '@prisma/client';

import { getAuthServiceIdentifier, requireEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import type { ClientConfig } from './config.service.js';
import { finalizeAuthenticatedUser } from './access-request-flow.service.js';
import { lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import {
  lockProductWorkspacePolicyShared,
} from './product-workspace-policy-lock.service.js';
import { resolveTwoFaPolicy } from './twofactor-policy.service.js';
import { signTwoFaChallenge } from './twofactor-challenge.service.js';
import { startTwoFactorSetup, type TwoFactorSetupResult } from './twofactor-setup.service.js';

type FinalizeWithPolicyDeps = {
  currentTwoFaEnabled?: boolean;
  policyLockHeld?: boolean;
  policyPrisma?: PrismaClient;
  prisma?: PrismaClient;
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
    credentialEpoch: number;
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
  if (!deps?.policyLockHeld) {
    const transactionPrisma = deps?.prisma ?? getAdminPrisma();
    return runInTransaction(transactionPrisma, async (tx) => {
      // The global product-policy fence is always first. Organisation/domain
      // policy writers take its exclusive form, so the policy decision and
      // challenge/setup/code write form one serializable unit.
      await lockProductWorkspacePolicyShared(tx);
      const authenticationState = await lockAndAssertAuthenticationEpoch(
        {
          userId: params.userId,
          domain: params.config.domain,
          credentialEpoch: params.credentialEpoch,
        },
        { prisma: tx, fallbackTwoFaEnabled: params.twoFaEnabled },
      );
      return finalizeWithTwoFaPolicy(params, {
        ...deps,
        policyLockHeld: true,
        prisma: tx,
        policyPrisma: deps?.policyPrisma ?? tx,
        workspacePrisma: deps?.workspacePrisma ?? tx,
        currentTwoFaEnabled: authenticationState.twoFaEnabled,
      });
    });
  }

  const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
  const audience = getAuthServiceIdentifier();

  // When workspace selection is transactional, use that transaction so a
  // freshly accepted invite's organisation policy is visible before commit.
  const twoFaPolicy = await resolveTwoFaPolicy(
    {
      config: params.config,
      userId: params.userId,
      orgId:
        params.orgId ??
        (params.requestAccess ? params.config.access_requests?.target_org_id : undefined),
    },
    deps?.prisma ? { prisma: deps.prisma } : undefined,
  );

  const twoFaEnabled = deps?.currentTwoFaEnabled ?? params.twoFaEnabled;
  if (twoFaPolicy !== 'OFF' && twoFaEnabled) {
    const twofa_token = await signTwoFaChallenge({
      userId: params.userId,
      credentialEpoch: params.credentialEpoch,
      domain: params.config.domain,
      configUrl: params.configUrl,
      redirectUrl: params.redirectUrl,
      authMethod: params.authMethod,
      rememberMe: params.rememberMe,
      requestAccess: params.requestAccess,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      orgId: params.orgId,
      teamId: params.teamId,
      sharedSecret: SHARED_SECRET,
      audience,
    });
    return { kind: 'twofa', twofa_token };
  }

  if (twoFaPolicy === 'REQUIRED') {
    const setup = await startTwoFactorSetup(
      {
        userId: params.userId,
        credentialEpoch: params.credentialEpoch,
        config: params.config,
        configUrl: params.configUrl,
        finalize: {
          authMethod: params.authMethod,
          redirectUrl: params.redirectUrl,
          rememberMe: params.rememberMe,
          requestAccess: params.requestAccess,
          codeChallenge: params.codeChallenge,
          codeChallengeMethod: params.codeChallengeMethod,
          orgId: params.orgId,
          teamId: params.teamId,
        },
      },
      deps?.prisma ? { prisma: deps.prisma } : undefined,
    );
    return { kind: 'twofa_enroll_required', setup };
  }

  const finalResult = await finalizeAuthenticatedUser(
    {
      userId: params.userId,
      credentialEpoch: params.credentialEpoch,
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
      orgId: params.orgId,
      teamId: params.teamId,
    },
    deps?.prisma
      ? {
          prisma: deps.prisma,
          policyPrisma: deps.policyPrisma ?? deps.prisma,
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
