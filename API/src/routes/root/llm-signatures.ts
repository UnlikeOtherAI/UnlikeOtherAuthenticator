export const llmSignaturesMarkdown = `
---

## Optional per-domain agreement signatures (operator API)

Agreement signatures are an authenticator service that a UOA platform superuser enables per domain. The process default and every new domain default are disabled, so existing authorization and refresh behavior remain unchanged until the domain is explicitly configured and enabled.

Current operator workflow, all under \`/internal/admin/domains/:domain/signatures/*\` with an admin-domain superuser bearer token:

1. \`POST .../agreements\` creates an ordered agreement definition.
2. \`POST .../agreements/:agreementId/versions\` uploads \`multipart/form-data\` containing exactly one \`application/pdf\` field named \`file\`, plus \`title\`, \`signing_method\` (\`clickwrap\` or \`typed_name\`), and the exact \`acceptance_statement\`.
3. UOA enforces configured byte/page bounds, rejects active PDF content, requires a successful ClamAV scan, hashes the exact upload with SHA-256, and writes it to private immutable object storage.
4. Draft metadata/source may be edited or the draft may be deleted. \`POST .../versions/:versionId/publish\` makes it immutable, supersedes the prior published version atomically, and increments \`policy_revision\`.
5. \`PUT .../settings\` with \`{ "enabled": true, "retention_days": 365 }\` enables the gate only after private storage, ClamAV, dedicated evidence private/public keys, explicit retention, and at least one active published required version are ready.

\`GET /internal/admin/domains/:domain/signatures\` returns settings, agreements and versions in display order, signature counts, and the latest audit events. Exact source bytes are available only through the authenticated no-store \`.../versions/:versionId/source\` download.

Published versions, signatures, revocations, and signature audit events are protected by database append-only/immutability triggers. A required published version cannot be withdrawn while the domain gate is enabled. Publishing a replacement is the supported atomic transition.

The evidence signing key is a dedicated RS256 RSA JWK with a unique \`kid\`; it must never reuse config, access-token, admin-token, shared-secret, or email-token key material. \`SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON\` contains public-only current and retired keys so historical evidence remains verifiable after rotation.

See [the JSON endpoint contract](/api) and \`Docs/Requirements/domain-signatures.md\` for the complete fixed security and lifecycle requirements.
`;
