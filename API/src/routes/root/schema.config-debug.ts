import type { EndpointSchema } from './schema.js';

export const configDebugEndpoints: EndpointSchema[] = [
  {
    method: 'POST',
    path: '/config/verify',
    description:
      'Debug configuration validation for raw config JSON, config JWTs, or config_url fetch targets',
    body: {
      'config?': 'object — raw config payload to schema-validate directly',
      'config_jwt?': 'string — signed config JWT to decode and validate',
      'config_url?': 'string — URL that should return the signed config JWT',
      'jwks_url?':
        'string — JWKS URL used to verify the RS256 JWT signature; defaults to CONFIG_JWKS_URL',
      'auth_service_identifier?':
        'string — expected JWT audience; defaults to the auth service environment when omitted',
    },
    response: {
      ok: 'boolean — true when every executed validation check passed',
      schema_valid: 'boolean — true when the config payload matches the schema',
      jwt_signature_valid:
        'boolean|null — null when signature validation was skipped',
      audience_valid:
        'boolean|null — null when audience validation was skipped',
      domain_match:
        'boolean|null — null when config_url/domain matching was not applicable',
      checks: 'object — stage-by-stage results for source, fetch, decode, signature, audience, schema, and domain_match',
      issues: 'array — explicit validation/debug issues with stage, code, summary, and details',
    },
  },
];
