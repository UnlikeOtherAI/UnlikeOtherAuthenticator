import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from './config.service.js';

import { buildRedirectToUrl, issueAuthorizationCode } from './authorization-code.service.js';
import { handlePostAuthenticationAccessRequest } from './access-request.service.js';
import { assertEmailDomainAllowedForLogin } from './login-domain-policy.service.js';
import { assertNotBannedAtLogin } from './ban-policy.service.js';

type FinalizeDeps = {
  prisma?: PrismaClient;
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
    config: ClientConfig;
    configUrl: string;
    redirectUrl: string;
    rememberMe: boolean;
    requestAccess: boolean;
    codeChallenge?: string;
    codeChallengeMethod?: 'S256';
    ip?: string | null;
    // Workspace scope resolved by /auth/select-team (design §7 step 3-4, Phase 3b Task 6). Every
    // other caller omits these, so the issued code carries no scope (unchanged behaviour).
    orgId?: string;
    teamId?: string;
  },
  deps?: FinalizeDeps,
): Promise<
  | { status: 'granted'; redirectTo: string; code: string }
  | { status: 'requested'; redirectTo: string }
> {
  // Allowed-login-email-domain restrictions (client domain / org / team). SUPERUSER bypasses.
  // Runs on the BYPASSRLS admin client, so it does not receive the request's tenant prisma.
  await assertEmailDomainAllowedForLogin({
    userId: params.userId,
    domain: params.config.domain,
  });

  // Admin ban list (client domain / org / team). A ban overrides any allow-list; SUPERUSER
  // bypasses. Also on the BYPASSRLS admin client. IP is enforced when the route supplies it.
  await assertNotBannedAtLogin({
    userId: params.userId,
    domain: params.config.domain,
    ip: params.ip,
  });

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

  const { code } = await issueAuthorizationCode(
    {
      userId: params.userId,
      domain: params.config.domain,
      configUrl: params.configUrl,
      redirectUrl: params.redirectUrl,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      rememberMe: params.rememberMe,
      orgId: params.orgId,
      teamId: params.teamId,
    },
    deps?.prisma ? { prisma: deps.prisma } : undefined,
  );

  return {
    status: 'granted',
    code,
    redirectTo: buildRedirectToUrl({
      redirectUrl: params.redirectUrl,
      code,
    }),
  };
}
