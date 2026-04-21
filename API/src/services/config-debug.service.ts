import { decodeJwt, decodeProtectedHeader, type JWTPayload } from 'jose';
import { z } from 'zod';

import { getEnv } from '../config/env.js';
import { formatZodIssues } from './auth-debug-page.service.js';
import {
  assertConfigDomainMatchesConfigUrl,
  validateConfigFields,
  verifyConfigJwtSignature,
  type ClientConfig,
} from './config.service.js';
import { containsSecretValue } from './config-secret-scan.service.js';
import { readConfigJwtFromTrustedSource } from './config-jwt-source.service.js';
import {
  buildConfigGuidance,
  buildConfigSummary,
  collectRuntimePolicyDetails,
  type ConfigValidationGuidance,
} from './config-validation-guidance.service.js';

const VerifyConfigBodySchema = z
  .object({
    config: z.record(z.unknown()).optional(),
    config_jwt: z.string().trim().min(1).optional(),
    config_url: z.string().trim().min(1).optional(),
    jwks_url: z.string().trim().url().optional(),
    auth_service_identifier: z.string().trim().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.config && !value.config_jwt && !value.config_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide config, config_jwt, or config_url.',
        path: ['config'],
      });
    }
  });

const ValidateConfigBodySchema = z
  .object({
    config: z.record(z.unknown()).optional(),
    config_jwt: z.string().trim().min(1).optional(),
    config_url: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.config && !value.config_jwt && !value.config_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide config, config_jwt, or config_url.',
        path: ['config'],
      });
    }
  });

type CheckStatus = 'passed' | 'failed' | 'skipped';

type CheckResult = {
  status: CheckStatus;
  summary: string;
  details?: string[];
};

type VerifyConfigRequest = z.infer<typeof VerifyConfigBodySchema>;
type ValidateConfigRequest = z.infer<typeof ValidateConfigBodySchema>;

type VerifyConfigIssue = {
  stage: string;
  code: string;
  summary: string;
  details: string[];
};

export type VerifyConfigResponse = {
  ok: boolean;
  source: 'config' | 'config_jwt' | 'config_url';
  schema_valid: boolean;
  jwt_signature_valid: boolean | null;
  audience_valid: boolean | null;
  domain_match: boolean | null;
  checks: Record<string, CheckResult>;
  issues: VerifyConfigIssue[];
  recommendations: ConfigValidationGuidance[];
  config_summary: Record<string, unknown> | null;
};

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function readAudienceClaim(payload: JWTPayload): string[] {
  if (typeof payload.aud === 'string') {
    return [payload.aud];
  }
  if (Array.isArray(payload.aud)) {
    return payload.aud.filter((value): value is string => typeof value === 'string');
  }
  return [];
}

function validateRuntimePolicy(response: VerifyConfigResponse, config: ClientConfig): void {
  const details = collectRuntimePolicyDetails(config);

  if (!details.length) {
    passedCheck(response, 'runtime_policy', 'Runtime auth policy checks passed.');
    return;
  }

  failedCheck(
    response,
    'runtime_policy',
    'CONFIG_RUNTIME_POLICY_INVALID',
    'The configuration passed schema validation but would fail or confuse auth runtime policy.',
    details,
  );
}

function failedCheck(
  response: VerifyConfigResponse,
  stage: string,
  code: string,
  summary: string,
  details: string[] = [],
): void {
  response.ok = false;
  response.checks[stage] = {
    status: 'failed',
    summary,
    ...(details.length ? { details } : {}),
  };
  response.issues.push({ stage, code, summary, details });
}

function passedCheck(
  response: VerifyConfigResponse,
  stage: string,
  summary: string,
  details?: string[],
): void {
  response.checks[stage] = {
    status: 'passed',
    summary,
    ...(details?.length ? { details } : {}),
  };
}

function skippedCheck(
  response: VerifyConfigResponse,
  stage: string,
  summary: string,
): void {
  response.checks[stage] = {
    status: 'skipped',
    summary,
  };
}

export function parseVerifyConfigRequest(input: unknown): VerifyConfigRequest {
  return VerifyConfigBodySchema.parse(input);
}

export function parseValidateConfigRequest(input: unknown): ValidateConfigRequest {
  return ValidateConfigBodySchema.parse(input);
}

export async function verifyClientConfig(
  params: VerifyConfigRequest,
): Promise<VerifyConfigResponse> {
  const source: VerifyConfigResponse['source'] = params.config
    ? 'config'
    : params.config_jwt
      ? 'config_jwt'
      : 'config_url';

  const response: VerifyConfigResponse = {
    ok: true,
    source,
    schema_valid: false,
    jwt_signature_valid: null,
    audience_valid: null,
    domain_match: null,
    checks: {},
    issues: [],
    recommendations: [],
    config_summary: null,
  };

  let payload: JWTPayload | undefined;
  let configJwt: string | undefined;
  const env = getEnv();
  const expectedAudience = params.auth_service_identifier?.trim() || env.AUTH_SERVICE_IDENTIFIER;
  const jwksUrl = params.jwks_url?.trim() || env.CONFIG_JWKS_URL;

  passedCheck(response, 'source', `Using ${source} as the configuration source.`);

  if (source === 'config') {
    payload = params.config as JWTPayload;
  } else if (source === 'config_jwt') {
    configJwt = params.config_jwt?.trim();
  } else {
    try {
      configJwt = await readConfigJwtFromTrustedSource(params.config_url ?? '');
      passedCheck(response, 'fetch', 'Fetched a config JWT from config_url.');
    } catch {
      failedCheck(
        response,
        'fetch',
        'CONFIG_FETCH_FAILED',
        'The auth service could not fetch a usable config JWT from config_url.',
      );
      skippedCheck(response, 'decode', 'JWT decode was skipped because fetch failed.');
      skippedCheck(response, 'secret_scan', 'Secret scan was skipped because fetch failed.');
      skippedCheck(response, 'signature', 'Signature verification was skipped because no JWT was available.');
      skippedCheck(response, 'audience', 'Audience verification was skipped because no JWT payload was available.');
      skippedCheck(response, 'schema', 'Schema validation was skipped because no config payload was available.');
      skippedCheck(response, 'runtime_policy', 'Runtime policy checks were skipped because no config payload was available.');
      skippedCheck(response, 'domain_match', 'Domain matching was skipped because no parsed config was available.');
      return response;
    }
  }

  if (configJwt) {
    try {
      const header = decodeProtectedHeader(configJwt);
      payload = decodeJwt(configJwt);
      passedCheck(
        response,
        'decode',
        'Decoded the config JWT payload without trusting it yet.',
        typeof header.alg === 'string' ? [`alg: ${header.alg}`] : undefined,
      );
    } catch {
      failedCheck(
        response,
        'decode',
        'CONFIG_JWT_MALFORMED',
        'The supplied config JWT could not be decoded.',
      );
      skippedCheck(response, 'signature', 'Signature verification was skipped because JWT decode failed.');
      skippedCheck(response, 'secret_scan', 'Secret scan was skipped because JWT decode failed.');
      skippedCheck(response, 'audience', 'Audience verification was skipped because JWT decode failed.');
      skippedCheck(response, 'schema', 'Schema validation was skipped because JWT decode failed.');
      skippedCheck(response, 'runtime_policy', 'Runtime policy checks were skipped because JWT decode failed.');
      skippedCheck(response, 'domain_match', 'Domain matching was skipped because no parsed config was available.');
      return response;
    }

    if (jwksUrl) {
      try {
        await verifyConfigJwtSignature(configJwt, jwksUrl, expectedAudience);
        response.jwt_signature_valid = true;
        passedCheck(response, 'signature', 'The configured JWKS verified the RS256 config JWT signature.');
      } catch {
        response.jwt_signature_valid = false;
        failedCheck(
          response,
          'signature',
          'CONFIG_JWKS_SIGNATURE_INVALID',
          'The configured JWKS did not verify the config JWT signature and audience.',
          ['Check that the JWT header includes a valid kid, uses RS256, and matches the configured JWKS.'],
        );
      }
    } else {
      skippedCheck(
        response,
        'signature',
        'Signature verification was skipped because no JWKS URL was configured.',
      );
    }
  } else {
    skippedCheck(response, 'decode', 'JWT decode was skipped because a raw config object was provided.');
    skippedCheck(response, 'signature', 'Signature verification was skipped because no JWT was provided.');
  }

  if (payload) {
    if (containsSecretValue(payload, env.SHARED_SECRET)) {
      failedCheck(
        response,
        'secret_scan',
        'CONFIG_PAYLOAD_SECRET_REJECTED',
        'The configuration payload contains this auth service shared secret.',
        ['Remove shared secrets, OAuth secrets, refresh tokens, and private keys from config payloads.'],
      );
    } else {
      passedCheck(response, 'secret_scan', 'No auth service shared secret was found in the config payload.');
    }
  } else {
    skippedCheck(response, 'secret_scan', 'Secret scan was skipped because no config payload was available.');
  }

  if (payload && source !== 'config') {
    const audiences = readAudienceClaim(payload);
    if (!audiences.length) {
      response.audience_valid = false;
      failedCheck(
        response,
        'audience',
        'CONFIG_AUDIENCE_MISSING',
        'The config JWT is missing an aud claim.',
        [`Expected auth_service_identifier: ${expectedAudience}`],
      );
    } else if (!audiences.includes(expectedAudience)) {
      response.audience_valid = false;
      failedCheck(
        response,
        'audience',
        'CONFIG_AUDIENCE_INVALID',
        'The config JWT aud claim does not include the expected auth_service_identifier.',
        [`Expected: ${expectedAudience}`, `Received: ${audiences.join(', ')}`],
      );
    } else {
      response.audience_valid = true;
      passedCheck(response, 'audience', 'The config JWT aud claim matches the expected auth_service_identifier.');
    }
  } else {
    skippedCheck(
      response,
      'audience',
      source === 'config'
        ? 'Audience verification was skipped because a raw config object was provided.'
        : 'Audience verification was skipped because no config payload was available.',
    );
  }

  let config: ClientConfig | undefined;
  if (payload) {
    try {
      config = validateConfigFields(payload);
      response.schema_valid = true;
      response.config_summary = buildConfigSummary(config);
      passedCheck(response, 'schema', 'The configuration payload passed schema validation.');
      validateRuntimePolicy(response, config);
      response.recommendations.push(...buildConfigGuidance(config, payload));
    } catch (err) {
      if (err instanceof z.ZodError) {
        response.schema_valid = false;
        failedCheck(
          response,
          'schema',
          'CONFIG_SCHEMA_INVALID',
          'The configuration payload failed schema validation.',
          formatZodIssues(err),
        );
        skippedCheck(response, 'runtime_policy', 'Runtime policy checks were skipped because schema validation failed.');
      } else {
        throw err;
      }
    }
  } else {
    skippedCheck(response, 'schema', 'Schema validation was skipped because no config payload was available.');
    skippedCheck(response, 'runtime_policy', 'Runtime policy checks were skipped because no config payload was available.');
  }

  if (config && params.config_url) {
    try {
      assertConfigDomainMatchesConfigUrl(config.domain, params.config_url);
      response.domain_match = true;
      passedCheck(response, 'domain_match', 'config.domain matches the hostname of config_url.');
    } catch {
      response.domain_match = false;
      let configUrlHost = 'unknown';
      try {
        configUrlHost = normalizeHostname(new URL(params.config_url).hostname);
      } catch {
        // Keep fallback value.
      }
      failedCheck(
        response,
        'domain_match',
        'CONFIG_DOMAIN_MISMATCH',
        'config.domain does not match the hostname of config_url.',
        [`config.domain: ${config.domain}`, `config_url host: ${configUrlHost}`],
      );
    }
  } else {
    skippedCheck(
      response,
      'domain_match',
      params.config_url
        ? 'Domain matching was skipped because schema validation did not succeed.'
        : 'Domain matching was skipped because config_url was not provided.',
    );
  }

  return response;
}
