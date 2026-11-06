import type { EndpointSchema } from './schema.js';

export const jobComputeContinuationEndpoint: EndpointSchema = {
  method: 'POST',
  path: '/billing/v1/ledger/job-compute-renewals/:grantId/continue',
  description: 'Derive one bounded successor compute grant for the same DeepWater research run',
  auth: 'Original product-bound Ledger runtime bearer and X-UOA-Delegation renewed from the named parent job-compute grant',
  body: {
    origin_invocation_id: 'Exact parent origin invocation',
    ledger_job_id: 'New Ledger attempt id',
    water_job_id: 'Exact parent Water UUIDv4',
    scope_turn_id: 'null', purpose: 'research_compute',
    issue_key: '64 lowercase hex characters; stable for this continuation',
    secret: 'Fresh one-use delivery secret: uoa_job_ plus 43 base64url characters',
  },
  response: {
    grant_id: 'UUID', expires_at: 'Original parent expiry, never extended',
    ledger_job_id: 'Requested successor attempt', water_job_id: 'Unchanged Water run',
    scope_turn_id: 'null', purpose: 'research_compute',
  },
  notes: 'DeepWater-origin research only. One child per parent; exact replay returns that child. '
    + 'Current epoch, identity, memberships, product keys, mappings and all ancestor grants are rechecked. '
    + 'Ledger separately validates failed-attempt eligibility, immutable configuration and no-dispatch proofs. '
    + 'A job token cannot issue an unrelated fresh grant or pass through generic token exchange. Responses are no-store.',
};

export const jobComputeContinuationMarkdown = `## DeepWater infrastructure recovery
Ledger can derive one successor compute grant with
POST /billing/v1/ledger/job-compute-renewals/:grantId/continue. Authenticate with
the original product's Ledger runtime key and X-UOA-Delegation renewed from that
exact parent grant. Send the unchanged origin_invocation_id and water_job_id,
new ledger_job_id, null scope_turn_id, research_compute purpose, and the durable
child issue_key/secret. See /api for the exact request and response.

The child retains the original subject, credential epoch, organisation, team,
origin and expiry. No browser login or general human delegation is minted.
Every renewal/dispatch checks all ancestors; revoking any ancestor blocks its
descendants. Conflicting children return 409. Missing, expired or revoked
authority fails closed. Ledger must verify the failed attempt and exact
no-dispatch evidence before creating a successor; UOA does not inspect provider
content. This endpoint does not enable recovery of other products or scope turns.
`;
