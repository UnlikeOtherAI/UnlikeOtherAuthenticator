import type { EndpointSchema } from './schema.js';

const capabilityAuth =
  'short-lived opaque signing_token capability in the JSON body; token hash only is stored';

export const signatureEndpoints: EndpointSchema[] = [
  {
    method: 'POST',
    path: '/signatures/session',
    description:
      'Read the current missing agreements and receipts for a hosted signing continuation',
    auth: capabilityAuth,
    body: { signing_token: 'string (required, 24-512)' },
    response: {
      complete: 'boolean — current server-side policy result',
      policy_revision: 'integer',
      agreements:
        'ordered current missing versions with exact title, description, method, acceptance statement, filename, and source SHA-256',
      receipts:
        'receipts created by this continuation, including verification reference/hash/state',
    },
    notes:
      'Private no-store response. Invalid, expired, consumed, and exhausted capabilities fail identically.',
  },
  {
    method: 'POST',
    path: '/signatures/session/source',
    description:
      'Stream the exact verified source PDF for a version currently required in this continuation',
    auth: capabilityAuth,
    body: {
      signing_token: 'string (required)',
      agreement_version_id: 'string (required)',
    },
    response: { 200: 'application/pdf inline; private no-store; SHA-256 ETag' },
  },
  {
    method: 'POST',
    path: '/signatures/session/sign',
    description:
      'Durably claim exact inputs, create deterministic evidence outside database locks, then revalidate and append one immutable signature for a currently missing version',
    auth: `${capabilityAuth}; same-origin browser mutation`,
    body: {
      signing_token: 'string (required)',
      agreement_version_id: 'string (required; revalidated server-side)',
      accepted: 'boolean (required; must be true)',
      typed_name: 'string|null (required only for typed_name; forbidden for clickwrap)',
    },
    response: {
      signature_id: 'string',
      verification_reference: 'non-guessable public reference',
      receipt_pdf_sha256: 'lowercase SHA-256',
      session: 're-evaluated current session; retries are idempotent',
    },
  },
  {
    method: 'POST',
    path: '/signatures/session/receipt',
    description: 'Download a hash-verified receipt created by this exact signing continuation',
    auth: capabilityAuth,
    body: { signing_token: 'string (required)', signature_id: 'string (required)' },
    response: { 200: 'application/pdf attachment; private no-store; SHA-256 ETag' },
  },
  {
    method: 'POST',
    path: '/signatures/session/complete',
    description:
      'Atomically re-check policy, consume the continuation once, issue the authorization code, and return the preserved redirect',
    auth: `${capabilityAuth}; same-origin browser mutation`,
    body: { signing_token: 'string (required)' },
    response: {
      complete: 'boolean',
      signatures_required: 'true only when policy changed and more signing is required',
      redirect_to: 'preserved validated OAuth/config-JWT continuation target',
    },
  },
  {
    method: 'GET',
    path: '/signatures/me/status',
    description: 'Read current agreement completion for the access-token subject and token domain',
    auth: 'X-UOA-Access-Token header',
    response: {
      enabled: 'boolean',
      complete: 'boolean',
      policy_revision: 'integer',
      requirements: 'current ordered requirements and subject-owned current receipt references',
    },
  },
  {
    method: 'GET',
    path: '/signatures/me/receipts/:signatureId',
    description:
      'Download a hash-verified receipt restricted to the access-token subject and domain',
    auth: 'X-UOA-Access-Token header',
    response: { 200: 'application/pdf attachment; private no-store; SHA-256 ETag' },
  },
  {
    method: 'GET',
    path: '/signatures/verify/:reference',
    description:
      'Public PII-minimised verification of evidence JWS, source bytes, receipt bytes, and revocation state',
    auth: 'public (IP rate-limited; non-guessable reference)',
    response: {
      state: 'valid | revoked',
      integrity_verified: 'true',
      allowed_fields:
        'verification_reference, agreement/version IDs, version number, source/receipt hashes, signed_at, evidence_kid, revoked_at',
      pii: 'never returns user ID, name, email, IP address, or user agent',
    },
  },
  {
    method: 'POST',
    path: '/domain/signatures/status',
    description:
      'Domain backend read of current agreement completion for one user on the verified domain',
    auth: 'verified config_url + domain hash bearer token',
    query: { config_url: 'string (required)' },
    body: { user_id: 'string (required; must have a role on the verified domain)' },
    response: {
      enabled: 'boolean',
      complete: 'boolean',
      policy_revision: 'integer',
      requirements: 'current ordered requirements and satisfaction evidence references',
    },
  },
];
