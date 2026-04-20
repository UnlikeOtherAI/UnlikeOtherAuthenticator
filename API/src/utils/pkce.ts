import { createHash, timingSafeEqual } from 'node:crypto';

import { AppError } from './errors.js';

export type PkceChallenge = {
  codeChallenge: string;
  codeChallengeMethod: 'S256';
};

const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function base64UrlSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function constantTimeEqual(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
}

export function parsePkceChallenge(params: {
  codeChallenge?: string;
  codeChallengeMethod?: string;
}): PkceChallenge | undefined {
  const codeChallenge = params.codeChallenge?.trim();
  const codeChallengeMethod = params.codeChallengeMethod?.trim();

  if (!codeChallenge && !codeChallengeMethod) {
    return undefined;
  }

  if (
    !codeChallenge ||
    codeChallengeMethod !== 'S256' ||
    !CODE_CHALLENGE_PATTERN.test(codeChallenge)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_PKCE_CHALLENGE');
  }

  return { codeChallenge, codeChallengeMethod };
}

export function parseRequiredPkceChallenge(params: {
  codeChallenge?: string;
  codeChallengeMethod?: string;
}): PkceChallenge {
  const challenge = parsePkceChallenge(params);
  if (!challenge) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_PKCE_CHALLENGE');
  }
  return challenge;
}

export function verifyPkceCodeVerifier(params: {
  codeVerifier?: string;
  codeChallenge: string;
}): void {
  const verifier = params.codeVerifier?.trim();
  if (!verifier || !CODE_VERIFIER_PATTERN.test(verifier)) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  }

  if (!constantTimeEqual(base64UrlSha256(verifier), params.codeChallenge)) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  }
}
