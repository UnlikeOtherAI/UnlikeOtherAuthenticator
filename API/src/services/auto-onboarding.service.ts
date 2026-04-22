import type { Prisma } from '@prisma/client';
import { decodeJwt, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { ZodError, z } from 'zod';

import { AppError } from '../utils/errors.js';
import { normalizeDomain } from '../utils/domain.js';
import {
  computeJwkFingerprint,
  findJwkByKid,
  importClientJwkKey,
} from './client-jwk.service.js';
import { fetchPartnerJwks } from './jwks-fetch.service.js';
import { validateConfigFields } from './config.service.js';
import {
  findOpenIntegrationRequest,
  upsertPendingIntegrationRequest,
  type IntegrationRequestRow,
  type UpsertPendingOutcome,
} from './integration-request.service.js';

const CONFIG_JWT_ALLOWED_ALGS = ['RS256'] as const;

const AutoOnboardingFieldsSchema = z.object({
  domain: z.string().trim().min(1),
  jwks_url: z.string().trim().min(1),
  contact_email: z.string().trim().min(3).email(),
});

export type AutoOnboardingOutcome =
  | {
      kind: 'pending';
      domain: string;
      contactEmail: string;
      status: 'PENDING';
      result: UpsertPendingOutcome['kind'];
    }
  | {
      kind: 'declined';
      domain: string;
      row: IntegrationRequestRow;
    };

function normalizeHostname(value: string): string {
  return normalizeDomain(value);
}

/**
 * Throws `CONFIG_JWT_INVALID` when the JWT cannot be decoded or does not opt into
 * auto-onboarding (missing `jwks_url` / `contact_email` / `domain`). Opt-in is the
 * signal that the partner intends to self-onboard — without it we want the
 * existing generic signature error to surface.
 */
function readAutoOnboardingFields(configJwt: string): {
  header: ReturnType<typeof decodeProtectedHeader>;
  payload: JWTPayload;
  domain: string;
  jwksUrl: string;
  contactEmail: string;
} {
  let header: ReturnType<typeof decodeProtectedHeader>;
  let payload: JWTPayload;
  try {
    header = decodeProtectedHeader(configJwt);
    payload = decodeJwt(configJwt);
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'CONFIG_JWT_INVALID');
  }

  const parsed = AutoOnboardingFieldsSchema.safeParse({
    domain: typeof payload.domain === 'string' ? payload.domain : '',
    jwks_url: typeof payload.jwks_url === 'string' ? payload.jwks_url : '',
    contact_email: typeof payload.contact_email === 'string' ? payload.contact_email : '',
  });
  if (!parsed.success) {
    throw new AppError('BAD_REQUEST', 400, 'CONFIG_JWT_INVALID');
  }

  return {
    header,
    payload,
    domain: parsed.data.domain,
    jwksUrl: parsed.data.jwks_url,
    contactEmail: parsed.data.contact_email,
  };
}

function assertJwksHostMatchesDomain(jwksUrl: string, domain: string): void {
  let url: URL;
  try {
    url = new URL(jwksUrl);
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_JWKS_URL_INVALID');
  }
  if (url.protocol !== 'https:') {
    throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_JWKS_URL_INVALID');
  }
  if (normalizeHostname(url.hostname) !== normalizeHostname(domain)) {
    throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_JWKS_HOST_MISMATCH');
  }
}

function configSummary(payload: JWTPayload): Prisma.InputJsonValue | undefined {
  try {
    const config = validateConfigFields(payload);
    // Remove the fields that belong strictly to the onboarding flow so the stored
    // summary is a clean mirror of the steady-state config. Storing jwks_url is
    // redundant (we already persist it on the request row) and the contact_email
    // is captured separately.
    const { ui_theme, ...rest } = config;
    const safeTheme = {
      density: ui_theme.density,
      colors: ui_theme.colors,
      logo: { url: ui_theme.logo.url, alt: ui_theme.logo.alt },
    };
    return { ...rest, ui_theme: safeTheme } as unknown as Prisma.InputJsonValue;
  } catch (err) {
    if (err instanceof ZodError) return undefined;
    throw err;
  }
}

/**
 * Attempt to auto-onboard a config JWT whose `kid` is not yet registered.
 *
 * Steps:
 *   1. Decode JWT header + payload unverified (jose decodeProtectedHeader / decodeJwt).
 *   2. Require `jwks_url` + `contact_email` in the payload. Missing → CONFIG_JWT_INVALID
 *      (no opt-in; treat as normal unknown-kid failure).
 *   3. Enforce `URL(jwks_url).hostname === payload.domain` (case-insensitive).
 *   4. Fetch `jwks_url` via the SSRF-protected pipeline (64KB cap, 5s timeout, public
 *      IPs only, redirect cap 3).
 *   5. Find the JWT's `kid` in the JWKS. If absent → `INTEGRATION_KID_NOT_IN_JWKS`.
 *   6. Verify the JWT signature against that JWK with RS256 + 30s clock tolerance.
 *   7. Schema-validate the payload to capture a safe `config_summary`.
 *   8. If a `DECLINED` row exists for this domain, return a `declined` outcome without
 *      writing anything (decline-and-block).
 *   9. Otherwise upsert a `PENDING` request keyed by domain + fingerprint.
 */
export async function tryAutoOnboard(
  configJwt: string,
  configUrl: string,
): Promise<AutoOnboardingOutcome> {
  const { header, domain, jwksUrl, contactEmail } = readAutoOnboardingFields(configJwt);

  if (header.alg !== 'RS256') {
    throw new AppError('BAD_REQUEST', 400, 'CONFIG_JWT_INVALID');
  }

  const kid = typeof header.kid === 'string' ? header.kid.trim() : '';
  if (!kid) {
    throw new AppError('BAD_REQUEST', 400, 'CONFIG_JWT_INVALID');
  }

  assertJwksHostMatchesDomain(jwksUrl, domain);

  const existingOpen = await findOpenIntegrationRequest(domain);
  if (existingOpen?.status === 'DECLINED') {
    return { kind: 'declined', domain: normalizeHostname(domain), row: existingOpen };
  }

  const jwks = await fetchPartnerJwks(jwksUrl);
  const jwk = findJwkByKid(jwks, kid);
  if (!jwk) {
    throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_KID_NOT_IN_JWKS');
  }

  const keyLike = await importClientJwkKey(jwk);
  let verified: JWTPayload;
  try {
    const { payload: verifiedPayload } = await jwtVerify(configJwt, keyLike, {
      algorithms: [...CONFIG_JWT_ALLOWED_ALGS],
      clockTolerance: 30,
    });
    verified = verifiedPayload;
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_JWT_SIGNATURE_INVALID');
  }

  // Enforce that the verified payload's domain claim matches the unverified one we
  // used for the host check. Defensive: `decodeJwt` is not authenticated.
  if (
    typeof verified.domain !== 'string' ||
    normalizeHostname(verified.domain) !== normalizeHostname(domain)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_JWT_DOMAIN_MISMATCH');
  }

  const fingerprint = computeJwkFingerprint(jwk);
  const summary = configSummary(verified);

  const outcome = await upsertPendingIntegrationRequest({
    domain,
    kid: jwk.kid,
    publicJwk: jwk,
    jwkFingerprint: fingerprint,
    jwksUrl,
    configUrl,
    contactEmail,
    configSummary: summary,
  });

  return {
    kind: 'pending',
    domain: normalizeHostname(domain),
    contactEmail,
    status: 'PENDING',
    result: outcome.kind,
  };
}

export type AutoOnboardingFields = {
  domain: string;
  jwksUrl: string;
  contactEmail: string;
};

/**
 * Cheap check: returns the opt-in fields if present, otherwise null. Used by the
 * middleware to decide whether to attempt auto-onboarding when signature verification
 * fails — without the new fields we fall through to the generic error.
 */
export function readOptInFields(configJwt: string): AutoOnboardingFields | null {
  try {
    const { domain, jwksUrl, contactEmail } = readAutoOnboardingFields(configJwt);
    return { domain, jwksUrl, contactEmail };
  } catch {
    return null;
  }
}
