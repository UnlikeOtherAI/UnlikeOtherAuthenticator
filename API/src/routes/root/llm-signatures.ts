export const llmSignaturesMarkdown = `
---

## Optional per-domain agreement signatures

Agreement signatures are an authenticator service that a UOA platform superuser enables per domain. The process default and every new domain default are disabled, so existing authorization and refresh behavior remain unchanged until the domain is explicitly configured and enabled.

Current operator workflow, all under \`/internal/admin/domains/:domain/signatures/*\` with an admin-domain superuser bearer token:

1. \`POST .../agreements\` creates an ordered agreement definition.
2. \`POST .../agreements/:agreementId/versions\` uploads \`multipart/form-data\` containing exactly one \`application/pdf\` field named \`file\`, plus \`title\`, \`signing_method\` (\`clickwrap\` or \`typed_name\`), and the exact \`acceptance_statement\`.
3. UOA enforces configured byte/page bounds, rejects active PDF content, requires a successful ClamAV scan, hashes the exact upload with SHA-256, and writes it to private immutable object storage.
4. Draft metadata/source may be edited or the draft may be deleted. \`POST .../versions/:versionId/publish\` makes it immutable, supersedes the prior published version atomically, and increments \`policy_revision\`.
5. \`PUT .../settings\` with \`{ "enabled": true, "retention_days": 365 }\` enables the gate only after private storage, ClamAV, dedicated evidence private/public keys, explicit retention, and at least one active published required version are ready.

\`GET /internal/admin/domains/:domain/signatures\` returns settings, agreements and versions in display order, signature counts, and the latest audit events. Exact source bytes are available only through the authenticated no-store \`.../versions/:versionId/source\` download.

Operators search retained evidence through \`GET .../signatures/records\`, filtered by signer, agreement/version, or date range with bounded cursor pagination. \`GET .../records/:signatureId/receipt\` verifies the private object's SHA-256 before download and records the access in both audit logs. \`POST .../records/:signatureId/revoke\` requires a reason and appends one immutable revocation; retries return the original revocation rather than overwriting history.

Published versions, signatures, revocations, and signature audit events are protected by database append-only/immutability triggers. A required published version cannot be withdrawn while the domain gate is enabled. Publishing a replacement is the supported atomic transition.

The evidence signing key is a dedicated RS256 RSA JWK with a unique \`kid\`; it must never reuse config, access-token, admin-token, shared-secret, or email-token key material. \`SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON\` contains public-only current and retired keys so historical evidence remains verifiable after rotation.

### Authorization and refresh behavior

Every successful identity path—password, social, email link, email code, workspace selection, 2FA completion, and public-client OAuth—calls the same current-policy evaluator after authentication and required 2FA but before authorization-code creation. A missing signature returns the hosted Auth signing URL instead of a code. The opaque \`signing_token\` is short-lived, stored only as a keyed hash, removed from the browser address bar after hydration, and accepted only in JSON bodies under \`POST /signatures/session/*\`.

The hosted UI shows and downloads the exact hash-verified source PDF, presents the exact acceptance statement separately, requires explicit confirmation, captures a typed name only for \`typed_name\`, and offers the resulting receipt. A typed name is a user assertion—not independent identity verification. UOA describes this output as authenticated agreement evidence, never notarisation, PAdES, a qualified signature, or legal advice.

\`POST /signatures/session/sign\` first reserves one immutable durable claim for the exact continuation/version while holding the continuation and domain-policy locks. It commits that claim before reading object storage, generating the deterministic receipt PDF, signing the canonical RS256 evidence manifest, or writing the create-only receipt object. It then records evidence readiness and relocks continuation → policy → claim to recheck the exact policy revision, published-version inputs, signature/revocation history, and expiry immediately before atomically appending the signature and audit event. Duplicate/lost-response retries converge on the same claim; an existing receipt object is accepted only when its bytes match exactly. Any policy, version, revocation, or expiry drift fails closed without a signature.

\`POST /signatures/session/complete\` locks the domain policy, re-evaluates current versions/revocations, consumes the continuation once, and creates the authorization code in the same transaction. If policy changed during signing, the same session returns the newly missing version instead. Public OAuth \`state\`, \`scope\`, \`resource\`, client, redirect, and PKCE challenge are preserved exactly; authorize-time scope is bound to the one-time code and cannot be widened at token exchange.

Before rotating a config-JWT refresh token, UOA locks and re-evaluates the current domain signature policy in the same transaction as rotation and access-token construction. Missing or revoked evidence returns the normal invalid-grant-style failure and leaves the valid refresh token untouched; the client must restart interactive authorization. Disabled domains preserve the pre-module authorization and refresh behavior.

### Signer, backend, and public reads

* \`GET /signatures/me/status\` and \`GET /signatures/me/receipts/:signatureId\` require \`X-UOA-Access-Token\` and are restricted to that token's subject and domain.
* \`POST /domain/signatures/status?config_url=...\` requires the verified config plus the domain-hash bearer and accepts \`{ "user_id": "..." }\` only for a user on that domain.
* \`GET /signatures/verify/:reference\` is IP-rate-limited and verifies the evidence JWS, canonical-manifest hash, exact private source bytes, receipt bytes, evidence \`kid\`, and revocation state. Its response is deliberately limited to reference state, agreement/version identifiers, hashes, timestamp, and \`kid\`; it never exposes user ID, signer name, email, IP address, or user agent.

Published versions and retained evidence use restrictive foreign keys and append-only database triggers, so user/domain deletion cannot silently cascade away evidence. Drafts remain the only deletable agreement versions.

See [the JSON endpoint contract](/api) and \`Docs/Requirements/domain-signatures.md\` for the complete fixed security and lifecycle requirements.
`;
