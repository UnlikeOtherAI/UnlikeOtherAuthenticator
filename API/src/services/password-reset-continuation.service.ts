/**
 * The sign-in context a password reset carries from the page that asked for it, through the
 * emailed link, to the sign-in form shown after the new password is saved.
 *
 * Without it the reset landing rendered a login form with no PKCE challenge, so every sign-in
 * after a reset failed `INVALID_PKCE_CHALLENGE`. Registration links already carry the same
 * values (see `buildAuthUrl` in `routes/auth/email-registration-link.urls.ts`).
 *
 * None of it is a credential. The challenge is the public S256 hash; the code it later binds can
 * be exchanged only with the relying party's verifier, which never leaves that party. Each value
 * is re-checked on every hop and an invalid one is dropped, never trusted: the redirect must be
 * one of `config.redirect_urls` and the challenge must be a well-formed S256 challenge.
 */
import { z } from 'zod';

import type { ClientConfig } from './config.service.js';
import { selectRedirectUrl } from './authorization-code.service.js';
import { parsePkceChallenge, type PkceChallenge } from '../utils/pkce.js';

export type PasswordResetContinuation = {
  redirectUrl?: string;
  pkce?: PkceChallenge;
  requestAccess: boolean;
  state?: string;
};

export const passwordResetContinuationQuery = {
  redirect_url: z.string().min(1).max(2048).optional(),
  code_challenge: z.string().min(1).max(256).optional(),
  code_challenge_method: z.string().min(1).max(32).optional(),
  request_access: z.string().max(16).optional(),
  state: z.string().min(1).max(2048).optional(),
};

const ContinuationQuerySchema = z.object(passwordResetContinuationQuery);

type ContinuationQuery = z.infer<typeof ContinuationQuerySchema>;

function allowedRedirectUrl(config: ClientConfig, requested: string | undefined): string | undefined {
  if (!requested) return undefined;
  try {
    return selectRedirectUrl({ allowedRedirectUrls: config.redirect_urls, requestedRedirectUrl: requested });
  } catch {
    return undefined;
  }
}

function wellFormedPkce(query: ContinuationQuery): PkceChallenge | undefined {
  try {
    return parsePkceChallenge({
      codeChallenge: query.code_challenge,
      codeChallengeMethod: query.code_challenge_method,
    });
  } catch {
    return undefined;
  }
}

/** Reads the continuation from a request query, keeping only values that pass their checks. */
export function readPasswordResetContinuation(
  query: unknown,
  config: ClientConfig,
): PasswordResetContinuation {
  const parsed = ContinuationQuerySchema.safeParse(query);
  if (!parsed.success) return { requestAccess: false };
  return {
    redirectUrl: allowedRedirectUrl(config, parsed.data.redirect_url),
    pkce: wellFormedPkce(parsed.data),
    requestAccess: parsed.data.request_access === 'true',
    state: parsed.data.state,
  };
}

export function appendPasswordResetContinuation(
  params: URLSearchParams,
  continuation: PasswordResetContinuation | undefined,
): void {
  if (!continuation) return;
  if (continuation.redirectUrl) params.set('redirect_url', continuation.redirectUrl);
  if (continuation.pkce) {
    params.set('code_challenge', continuation.pkce.codeChallenge);
    params.set('code_challenge_method', continuation.pkce.codeChallengeMethod);
  }
  if (continuation.requestAccess) params.set('request_access', 'true');
  if (continuation.state) params.set('state', continuation.state);
}
