import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { TOKEN_EXCHANGE_GRANT_TYPE } from '../../services/confidential-token-exchange.service.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
type RateLimiter = ReturnType<typeof createRateLimiter>;

function getRequestIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

function normalizePart(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function hashPart(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
}

function bodyString(request: FastifyRequest, key: string): string {
  const body =
    request.body && typeof request.body === 'object'
      ? (request.body as Record<string, unknown>)
      : {};
  return normalizePart(body[key]);
}

function authIpKey(prefix: string, request: FastifyRequest): string {
  return `${prefix}:ip:${getRequestIp(request)}`;
}

function authBodyKey(prefix: string, request: FastifyRequest, key: string): string {
  const value = bodyString(request, key);
  return value ? `${prefix}:${key}:${hashPart(value)}` : '';
}

function composeRateLimiters(...limiters: RateLimiter[]): RateLimiter {
  return async function composedRateLimiter(request: FastifyRequest) {
    for (const limiter of limiters) {
      await limiter(request);
    }
  };
}

function ipRateLimiter(prefix: string, limit: number, windowMs: number): RateLimiter {
  return createRateLimiter({
    limit,
    windowMs,
    keyBuilder: (request) => authIpKey(prefix, request),
  });
}

// app.ts sets trustProxy: 1, so request.ip is the last X-Forwarded-For hop: if the edge does not
// overwrite a client-supplied XFF, every :ip: bucket above is attacker's choice. Compose each
// credential-guarding limiter with a GLOBAL bucket that has no request input, so a header-rotating
// attacker still hits a hard ceiling. Sized as a circuit breaker far above realistic aggregate
// legitimate traffic (hundreds of req/min even at a busy login burst), not as a quota.
function globalRateLimiter(prefix: string, limit: number): RateLimiter {
  return createRateLimiter({
    limit,
    windowMs: MINUTE_MS,
    keyBuilder: () => `${prefix}:global`,
  });
}

function bodyRateLimiter(prefix: string, key: string, limit: number, windowMs: number): RateLimiter {
  return createRateLimiter({
    limit,
    windowMs,
    keyBuilder: (request) => authBodyKey(prefix, request, key),
  });
}

function authIpDomainKey(prefix: string, request: FastifyRequest, domain: string): string {
  const normalized = normalizePart(domain);
  if (!normalized) return `${prefix}:ip:${getRequestIp(request)}`;
  return `${prefix}:ip+domain:${getRequestIp(request)}:${hashPart(normalized)}`;
}

export const loginRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:login', 10, MINUTE_MS),
  globalRateLimiter('auth:login', 10_000),
  bodyRateLimiter('auth:login', 'email', 5, 15 * MINUTE_MS),
);

export const registerRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:register', 10, MINUTE_MS),
  globalRateLimiter('auth:register', 5_000),
  bodyRateLimiter('auth:register', 'email', 5, HOUR_MS),
);

// Phase 3b: /auth/start is the email-first entry (register + optional login code). Same shape as
// registerRateLimiter but keyed separately so it doesn't share budget with /auth/register.
export const authStartRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:start', 10, MINUTE_MS),
  globalRateLimiter('auth:start', 5_000),
  bodyRateLimiter('auth:start', 'email', 5, HOUR_MS),
);

// Phase 3b (design §8): /auth/verify-code is IP- and email-keyed, tighter than login since a
// 6-digit code has a much smaller search space than a password.
export const verifyCodeRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:verify-code', 10, 15 * MINUTE_MS),
  globalRateLimiter('auth:verify-code', 5_000),
  bodyRateLimiter('auth:verify-code', 'email', 10, 15 * MINUTE_MS),
);

// Phase 3b: /auth/select-team is gated by a short-lived login_token; still rate-limit by IP and by
// the presented token so a leaked/guessed token can't be hammered for team/invite enumeration.
export const selectTeamRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:select-team', 20, MINUTE_MS),
  globalRateLimiter('auth:select-team', 5_000),
  bodyRateLimiter('auth:select-team', 'login_token', 20, 15 * MINUTE_MS),
);

// Phase 3b follow-up: /auth/session-choices is gated by the same login_token bridge as
// /auth/select-team — same IP + token-keyed shape so a leaked/guessed token can't be hammered.
export const sessionChoicesRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:session-choices', 20, MINUTE_MS),
  globalRateLimiter('auth:session-choices', 5_000),
  bodyRateLimiter('auth:session-choices', 'login_token', 20, 15 * MINUTE_MS),
);

export const resetRequestRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:reset-request', 10, MINUTE_MS),
  globalRateLimiter('auth:reset-request', 2_000),
  bodyRateLimiter('auth:reset-request', 'email', 3, HOUR_MS),
);

export const tokenConsumeRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:token-consume', 10, MINUTE_MS),
  globalRateLimiter('auth:token-consume', 5_000),
);

export const tokenExchangeRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:token-exchange', 10, MINUTE_MS),
  globalRateLimiter('auth:token-exchange', 5_000),
);

const confidentialTokenExchangeDomainLimiter = createRateLimiter({
  limit: 600,
  windowMs: MINUTE_MS,
  keyBuilder: (request) => {
    const domain = normalizePart(request.config?.domain);
    return domain ? `auth:token-exchange:confidential:domain:${hashPart(domain)}` : '';
  },
});

function isConfidentialTokenExchange(request: FastifyRequest): boolean {
  return bodyString(request, 'grant_type') === TOKEN_EXCHANGE_GRANT_TYPE;
}

/** Preserve the legacy 10/min/IP guard without placing confidential callers
 * behind one shared-egress bucket before they authenticate. */
export async function tokenExchangePreAuthRateLimiter(request: FastifyRequest): Promise<void> {
  if (!isConfidentialTokenExchange(request)) {
    await tokenExchangeRateLimiter(request);
  }
}

/** Confidential callers reach this guard only after config and domain-hash auth.
 * The broad domain ceiling bounds a compromised backend while per-user limits
 * are enforced after the subject assertion signature is verified. */
export async function confidentialTokenExchangeDomainRateLimiter(
  request: FastifyRequest,
): Promise<void> {
  if (isConfidentialTokenExchange(request)) {
    await confidentialTokenExchangeDomainLimiter(request);
  }
}

// Compound IP-only and per-challenge-token buckets so an attacker spraying many IPs
// can't burn another user's IP budget against the same `twofa_token`.
export const twoFactorVerifyRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:twofa-verify', 5, 15 * MINUTE_MS),
  globalRateLimiter('auth:twofa-verify', 2_000),
  bodyRateLimiter('auth:twofa-verify', 'twofa_token', 5, 15 * MINUTE_MS),
);

export const twoFactorSetupRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:twofa-setup', 5, 15 * MINUTE_MS),
  globalRateLimiter('auth:twofa-setup', 2_000),
);

export const twoFactorEnrollRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:twofa-enroll', 5, 15 * MINUTE_MS),
  globalRateLimiter('auth:twofa-enroll', 2_000),
  bodyRateLimiter('auth:twofa-enroll', 'setup_token', 5, 15 * MINUTE_MS),
);

export const twoFactorDisableRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:twofa-disable', 5, 15 * MINUTE_MS),
  globalRateLimiter('auth:twofa-disable', 2_000),
);

export const socialCallbackRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:social-callback', 20, MINUTE_MS),
  globalRateLimiter('auth:social-callback', 5_000),
);

export const configFetchRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:config-fetch', 60, MINUTE_MS),
  globalRateLimiter('auth:config-fetch', 10_000),
);

export const revokeRateLimiter = createRateLimiter({
  limit: 20,
  windowMs: MINUTE_MS,
  keyBuilder: (request) => {
    const domain = normalizePart(request.config?.domain);
    return authIpDomainKey('auth:revoke', request, domain);
  },
});

export const emailSendRateLimiter = createRateLimiter({
  limit: 60,
  windowMs: HOUR_MS,
  keyBuilder: (request) => {
    const domain = normalizePart(request.config?.domain);
    return authIpDomainKey('email:send', request, domain);
  },
});

export const emailTeamInviteOpenRateLimiter = composeRateLimiters(
  ipRateLimiter('auth:email-team-invite-open', 30, MINUTE_MS),
  globalRateLimiter('auth:email-team-invite-open', 2_000),
);
