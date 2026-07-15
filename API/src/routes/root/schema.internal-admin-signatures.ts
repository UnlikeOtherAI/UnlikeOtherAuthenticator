import type { EndpointSchema } from './schema.js';

export function buildInternalAdminSignatureEndpoints(params: {
  adminAuth: string;
  authFailures: string;
}): EndpointSchema[] {
  const { adminAuth, authFailures } = params;
  const agreementPath = '/internal/admin/domains/:domain/signatures/agreements/:agreementId';
  const versionPath = `${agreementPath}/versions/:versionId`;
  const agreementBody = {
    title: 'string (required, 1-200)',
    description: 'string|null (optional, max 1000)',
    display_order: 'integer (optional, 0-100000)',
    required_for_access: 'boolean (optional, default true)',
  };
  const versionMetadata = {
    title: 'string (required, 1-200)',
    signing_method: 'clickwrap | typed_name (required)',
    acceptance_statement: 'string (required, 1-4000; exact text shown and captured)',
  };

  return [
    {
      method: 'GET',
      path: '/internal/admin/domains/:domain/signatures',
      description: 'Read signature settings, ordered agreements/versions, signature counts, and the latest 100 signature audit events',
      auth: adminAuth,
      response: { 200: '{ settings, agreements, audit_events }', '401/403': authFailures },
    },
    {
      method: 'PUT',
      path: '/internal/admin/domains/:domain/signatures/settings',
      description: 'Enable/disable the optional domain signature gate and set explicit evidence retention. Enabling fails closed unless runtime storage, ClamAV, dedicated evidence keys, retention, and an active published required version are present.',
      auth: adminAuth,
      body: {
        enabled: 'boolean (required)',
        retention_days: 'integer 1-36500 or null (required; null is forbidden while enabled)',
      },
      response: { 200: 'Updated settings with policy_revision', '401/403': authFailures },
    },
    {
      method: 'POST',
      path: '/internal/admin/domains/:domain/signatures/agreements',
      description: 'Create an agreement definition on a registered domain',
      auth: adminAuth,
      body: agreementBody,
      response: { 201: 'Created agreement', '401/403': authFailures },
    },
    {
      method: 'PUT',
      path: agreementPath,
      description: 'Update agreement metadata/order/required state. Published versions retain their immutable title snapshots.',
      auth: adminAuth,
      body: agreementBody,
      response: { 200: 'Updated agreement', '401/403': authFailures },
    },
    {
      method: 'POST',
      path: `${agreementPath}/versions`,
      description: 'Upload one bounded PDF as a new draft version. Performs PDF structural/active-content checks, ClamAV scanning, exact SHA-256 hashing, private immutable storage, and audit.',
      auth: adminAuth,
      body: {
        content_type: 'multipart/form-data',
        file: 'one application/pdf file (required; configured byte limit)',
        ...versionMetadata,
      },
      response: { 201: 'Created draft version', 429: 'separate upload rate limit', '401/403': authFailures },
    },
    {
      method: 'PUT',
      path: versionPath,
      description: 'Edit signing metadata on a draft. Any published/superseded/withdrawn version is immutable.',
      auth: adminAuth,
      body: versionMetadata,
      response: { 200: 'Updated draft version', 409: 'immutable or invalid lifecycle transition', '401/403': authFailures },
    },
    {
      method: 'PUT',
      path: `${versionPath}/source`,
      description: 'Replace a draft source with one multipart application/pdf file; validates/scans/hashes/stores the replacement before retiring the previous draft object.',
      auth: adminAuth,
      body: { content_type: 'multipart/form-data', file: 'one application/pdf file (required)' },
      response: { 200: 'Updated draft version', 429: 'separate upload rate limit', '401/403': authFailures },
    },
    {
      method: 'POST',
      path: `${versionPath}/publish`,
      description: 'Atomically publish a draft, supersede the prior published version, and increment domain policy_revision. Concurrent publication is serialized on the agreement row.',
      auth: adminAuth,
      body: { effective_at: 'ISO-8601 datetime (optional, default now)' },
      response: { 200: 'Published version', 409: 'not publishable', '401/403': authFailures },
    },
    {
      method: 'POST',
      path: `${versionPath}/withdraw`,
      description: 'Withdraw the currently published version without deleting evidence. A required version cannot be withdrawn while its domain gate is enabled.',
      auth: adminAuth,
      response: { 200: 'Withdrawn version', 409: 'withdrawal would remove enabled requirement', '401/403': authFailures },
    },
    {
      method: 'DELETE',
      path: versionPath,
      description: 'Delete a draft version and its private draft object. Published/superseded/withdrawn versions cannot be deleted.',
      auth: adminAuth,
      response: { 204: 'No content', 409: 'published evidence is immutable', '401/403': authFailures },
    },
    {
      method: 'GET',
      path: `${versionPath}/source`,
      description: 'Download the exact private source PDF with no-store/nosniff headers after domain/agreement/version scoping.',
      auth: adminAuth,
      response: { 200: 'application/pdf attachment; ETag contains immutable SHA-256', '401/403': authFailures },
    },
  ];
}
