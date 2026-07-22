import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from './config.service.js';

import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { handlePostAuthenticationAccessRequest } from './access-request.service.js';
import { lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import { assertEmailDomainAllowedForLogin } from './login-domain-policy.service.js';
import { assertNotBannedAtLogin } from './ban-policy.service.js';
import {
  finalizeConfigAuthorizationWithSignatures,
  type SignatureContinuationDeps,
} from './signature-continuation.service.js';

type FinalizeDeps = {
  authenticationEpochLocked?: boolean;
  prisma?: PrismaClient;
  // Optional BYPASSRLS transaction used by workspace selection so freshly
  // accepted membership is visible to allow-list and ban policy reads before
  // the outer transaction commits.
  policyPrisma?: PrismaClient;
  // Explicit BYPASSRLS client for cross-product workspace lookup and scope
  // validation. This stays separate from login policy so ordinary route tests
  // and same-domain policy reads do not accidentally cross the RLS boundary.
  workspacePrisma?: PrismaClient;
  signatureDeps?: SignatureContinuationDeps;
};

export function parseRequestAccessFlag(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

export function buildAccessRequestedUrl(params: {
  configUrl: string;
  redirectUrl?: string;
}): string {
  const url = new URL('/auth', 'http://localhost');
  url.searchParams.set('config_url', params.configUrl);
  url.searchParams.set('request_access', 'true');
  url.searchParams.set('request_access_status', 'pending');
  if (params.redirectUrl) {
    url.searchParams.set('redirect_url', params.redirectUrl);
  }
  return `${url.pathname}${url.search}`;
}

export async function finalizeAuthenticatedUser(
  params: {
    userId: string;
    credentialEpoch: number;
    config: ClientConfig;
    configUrl: string;
    redirectUrl: string;
    rememberMe: boolean;
    requestAccess: boolean;
    authMethod: string;
    twoFaCompleted: boolean;
    codeChallenge?: string;
    codeChallengeMethod?: 'S256';
    ip?: string | null;
    // Workspace scope resolved by explicit selection, auto-selection, or
    // recognized-product placement. Legacy unresolved callers omit both.
    orgId?: string;
    teamId?: string;
  },
  deps?: FinalizeDeps,
): Promise<
  | { status: 'granted'; redirectTo: string; code: string }
  | { status: 'signing_required'; redirectTo: string; signingToken: string }
  | { status: 'requested'; redirectTo: string }
> {
  if (!deps?.authenticationEpochLocked) {
    const transactionPrisma = deps?.prisma ?? getAdminPrisma();
    return runInTransaction(transactionPrisma, (tx) =>
      finalizeAuthenticatedUser(params, {
        ...deps,
        authenticationEpochLocked: true,
        prisma: tx,
        policyPrisma: deps?.policyPrisma ?? tx,
        workspacePrisma: deps?.workspacePrisma ?? tx,
      }),
    );
  }

  await lockAndAssertAuthenticationEpoch(
    {
      userId: params.userId,
      domain: params.config.domain,
      credentialEpoch: params.credentialEpoch,
    },
    { prisma: deps.prisma ?? getAdminPrisma() },
  );

  // Allowed-login-email-domain restrictions (client domain / org / team). SUPERUSER bypasses.
  // Workspace selection injects its BYPASSRLS transaction so just-accepted membership is visible.
  const emailDomainPolicyInput = {
    userId: params.userId,
    domain: params.config.domain,
  };
  if (deps?.policyPrisma) {
    await assertEmailDomainAllowedForLogin(emailDomainPolicyInput, {
      prisma: deps.policyPrisma,
    });
  } else {
    await assertEmailDomainAllowedForLogin(emailDomainPolicyInput);
  }

  // Admin ban list (client domain / org / team). A ban overrides any allow-list; SUPERUSER
  // bypasses. Also on the BYPASSRLS admin client. IP is enforced when the route supplies it.
  const banPolicyInput = {
    userId: params.userId,
    domain: params.config.domain,
    ip: params.ip,
  };
  if (deps?.policyPrisma) {
    await assertNotBannedAtLogin(banPolicyInput, {
      prisma: deps.policyPrisma,
    });
  } else {
    await assertNotBannedAtLogin(banPolicyInput);
  }

  if (params.requestAccess) {
    const decision = await handlePostAuthenticationAccessRequest(
      {
        userId: params.userId,
        config: params.config,
      },
      deps?.prisma ? { prisma: deps.prisma } : undefined,
    );

    if (decision.status === 'requested') {
      return {
        status: 'requested',
        redirectTo: buildAccessRequestedUrl({
          configUrl: params.configUrl,
          redirectUrl: params.redirectUrl,
        }),
      };
    }
  }

  const signatureDeps =
    deps?.signatureDeps || deps?.workspacePrisma
      ? {
          ...deps?.signatureDeps,
          workspacePrisma: deps?.signatureDeps?.workspacePrisma ?? deps?.workspacePrisma,
        }
      : undefined;

  const gate = await finalizeConfigAuthorizationWithSignatures(
    {
      userId: params.userId,
      domain: params.config.domain,
      configUrl: params.configUrl,
      redirectUrl: params.redirectUrl,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      rememberMe: params.rememberMe,
      requestAccess: params.requestAccess,
      orgId: params.orgId,
      teamId: params.teamId,
      authMethod: params.authMethod,
      twoFaCompleted: params.twoFaCompleted,
    },
    signatureDeps,
  );

  if (gate.status === 'signing_required') {
    return {
      status: 'signing_required',
      signingToken: gate.signingToken,
      redirectTo: gate.redirectTo,
    };
  }
  return {
    status: 'granted',
    code: gate.code,
    redirectTo: gate.redirectTo,
  };
}
