import type { ClientConfig } from './config.service.js';

import { buildRedirectToUrl, issueAuthorizationCode } from './token.service.js';
import { handlePostAuthenticationAccessRequest } from './access-request.service.js';

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

export async function finalizeAuthenticatedUser(params: {
  userId: string;
  config: ClientConfig;
  configUrl: string;
  redirectUrl: string;
  rememberMe: boolean;
  requestAccess: boolean;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
}): Promise<
  | { status: 'granted'; redirectTo: string; code: string }
  | { status: 'requested'; redirectTo: string }
> {
  if (params.requestAccess) {
    const decision = await handlePostAuthenticationAccessRequest({
      userId: params.userId,
      config: params.config,
    });

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

  const { code } = await issueAuthorizationCode({
    userId: params.userId,
    domain: params.config.domain,
    configUrl: params.configUrl,
    redirectUrl: params.redirectUrl,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    rememberMe: params.rememberMe,
  });

  return {
    status: 'granted',
    code,
    redirectTo: buildRedirectToUrl({
      redirectUrl: params.redirectUrl,
      code,
    }),
  };
}
