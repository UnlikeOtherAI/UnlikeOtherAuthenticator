# Optional Domain Agreement Signature Module — Product Brief

This document defines the optional agreement signature service for the UnlikeOtherAI
Authenticator. It is incorporated by reference from the main [build brief](../brief.md).

## Purpose

Add an optional **agreement signature service** to the authenticator. An enabled client
domain can require an authenticated user to review and sign one or more published PDF
agreements before UOA issues an authorization code or refreshes access.

The service answers one narrow question:

> Has this authenticated UOA user signed every agreement version currently required by
> this client domain?

This is an authenticator module, not a general compliance platform. Phase 1 covers PDF
agreements, click-wrap acceptance, typed-name signatures, versioning, enforcement, and
evidence. KYC, business verification, sanctions screening, manual approval, arbitrary
forms, and multi-party contract orchestration are not part of this module.

## Domain-Level Feature Gate

* The signature service is **disabled by default** for every registered `ClientDomain`.
* An existing platform superuser enables it for one domain from that domain's Admin
  detail screen. Enabling it on one domain has no effect on any other domain, including
  another domain used by the same organisation or App.
* The persisted `ClientDomain` record is the authoritative feature gate. Phase 1 does
  not add a client-controlled config-JWT claim that can turn signature enforcement on
  or off.
* A domain cannot be enabled until it has at least one published, active, required
  agreement version. The Admin API must reject an invalid enable operation. If storage
  becomes inconsistent and an enabled domain has no valid requirement set, auth fails
  closed and logs the internal reason.
* Disabling the service immediately removes the signature gate from new authorization
  and refresh flows. It does not delete agreements, signatures, receipts, or audit
  records. Re-enabling restores enforcement against the then-active versions.
* Development, staging, and production are separate only when they use separate
  registered domains. There is no environment-name override that silently weakens a
  production domain's setting.

Example persisted domain setting:

```json
{
  "domain": "contracts.example.com",
  "signatures": {
    "enabled": true,
    "enforcement": "before_authorization_code"
  }
}
```

## Scope and Existing UOA Concepts

Phase 1 must use the existing UOA concepts rather than introducing parallel `Tenant`,
`Application`, or `Policy` identities:

* **Domain:** the verified `ClientDomain.domain` is the enforcement boundary.
* **User:** the signer is the existing UOA `User` identified by stable `userId`.
* **Organisation, Team, and App:** these remain unchanged. They do not own or override
  signature requirements in Phase 1.
* **Global users:** a global user signs independently per domain. A signature made for
  domain A never satisfies domain B, even when both domains resolve to the same UOA user.
* **Per-domain users:** the signature naturally follows the domain-scoped user row.

This domain-only scope intentionally avoids the repository's unresolved transition
between the legacy `Organisation.domain` model and the ReBAC domain-pool model.
Organisation-, team-, role-, App-, invitation-, and transaction-specific agreements are
future extensions and must not be inferred into Phase 1.

## Phase 1 Capabilities

An enabled domain supports:

* one or more required PDF agreements;
* draft, published, superseded, and withdrawn agreement-version states;
* an immutable SHA-256 hash for every uploaded source PDF;
* click-wrap acceptance;
* typed-name electronic signature;
* an exact, versioned acceptance statement displayed at signing time;
* mandatory re-signing when a new version becomes active;
* a UOA-hosted, themed and localized signing flow;
* an append-only signature and audit record;
* a downloadable evidence receipt for the signer and Admin operators;
* domain-backend status lookup;
* explicit signature revocation without deleting the historical record.

Drawn signatures, signature-field placement inside arbitrary PDFs, document-template
editing, multi-party signing, signing order, and transaction-generated contracts are
not included in Phase 1.

## Agreement and Version Lifecycle

An **Agreement** is a stable domain-owned record such as "Service Terms" or "NDA". An
**AgreementVersion** is the exact PDF and acceptance text a user signs.

Each Agreement contains:

* ID;
* owning domain;
* title and optional description;
* display order;
* whether it is currently required for access;
* created and updated timestamps.

Each AgreementVersion contains:

* ID and parent agreement ID;
* monotonically increasing integer version;
* original filename and private object-storage key;
* source PDF SHA-256 hash;
* signing method: `clickwrap` or `typed_name`;
* exact acceptance statement;
* status: `draft`, `published`, `superseded`, or `withdrawn`;
* publication and effective timestamps;
* publishing Admin identity;
* created timestamp.

Rules:

1. A draft may be replaced or deleted before publication.
2. A published version is immutable. Changing the PDF, title presented to the signer,
   signing method, or acceptance statement requires a new version.
3. Publishing a new version atomically supersedes the previous published version of the
   same Agreement and increments the domain's signature-policy revision.
4. The new version becomes the version required for future authorization and refresh
   decisions. Signatures on the superseded version remain valid historical evidence but
   no longer satisfy the current requirement.
5. Withdrawing a version removes it from the active requirement set without deleting it
   or its signatures. A required Agreement must have another published version before
   its current version can be withdrawn while the domain remains enabled.
6. Publication and withdrawal are privileged Admin actions and must create Admin audit
   events.

Phase 1 always requires re-signing after a new required version is published. Alternative
replacement behaviours such as "existing signatures remain valid" are deferred.

## Signing Position in the Auth Flow

Signature evaluation happens **after identity authentication and any required 2FA**, but
**before authorization-code issuance**:

```text
Verify config, domain, redirect and PKCE
                 ↓
Authenticate the user
                 ↓
Complete workspace selection and required 2FA
                 ↓
Is the signature service enabled for this domain?
        ├── No  → issue authorization code normally
        └── Yes → load active required agreement versions
                          ↓
              Has this user signed all versions?
                 ├── Yes → issue authorization code normally
                 └── No  → create signing continuation
                                      ↓
                         Review and sign missing versions
                                      ↓
                         Persist evidence successfully
                                      ↓
                         Consume continuation and issue code
```

The gate belongs at the shared finalization chokepoint immediately before
`issueAuthorizationCode()`. Every path that can finish authentication must use it,
including password login, verified-email registration, social login, email-code login,
workspace selection, and the public-client `/oauth/*` profile. No route may issue an
authorization code around the gate.

## Signing Continuation

When signatures are missing, UOA creates a short-lived, single-use signing continuation
instead of issuing an authorization code.

The server-side continuation must preserve all state needed to resume the exact flow:

* user ID and verified domain;
* auth profile (`/auth/*` config-JWT or `/oauth/*` public client);
* config URL when the profile uses one;
* validated redirect URL and OAuth state;
* PKCE code challenge and method;
* remember-me choice;
* selected organisation/team scope, where present;
* authentication method and whether 2FA was completed for the current login;
* expiry, consumed timestamp, and failed-attempt counter.

The browser receives only a random opaque capability token. UOA stores only its keyed
hash. The continuation must expire after a short bounded interval, be invalid after one
successful completion, and be protected from replay and concurrent double-use.

An expired, invalid, or consumed continuation returns the normal generic public error and
must never reveal whether a user or signature exists. The user can restart authentication.

## User Signing Experience

The signing flow is hosted inside the existing Auth application and must reuse the
verified config's theme and language settings.

For each missing AgreementVersion, the user must be able to:

1. see the agreement title, version, and explanatory copy;
2. view the exact PDF in a safe viewer;
3. download the source PDF;
4. see the exact acceptance statement separately from the PDF;
5. explicitly confirm the statement;
6. enter their full name when the method is `typed_name`;
7. submit a final unambiguous **Sign and continue** action;
8. download the resulting receipt after successful signing.

The typed name is a user assertion captured as evidence. It must not be described as
independent legal-identity verification. Reaching the final PDF page may be recorded as a
UI event, but UOA must not claim that it proves the user read or understood the document.

All required agreements are completed in Admin-defined display order. The authorization
code is issued only after every currently required version has a valid signature. If the
active requirement set changes while a user is in the flow, UOA re-evaluates at final
submission and presents any newly required version before issuing the code.

## Signature Evidence and Receipt

Every successful signature creates an immutable `AgreementSignature` record containing:

* signature ID and non-guessable public verification reference;
* user ID, user email, and captured display/legal name;
* domain;
* agreement ID, AgreementVersion ID, and integer version;
* source PDF hash;
* exact acceptance statement;
* signing method and typed name, where applicable;
* UTC server timestamp;
* authentication method;
* 2FA-completed state for that login;
* IP address and user agent, subject to the configured retention policy;
* signing-continuation ID;
* evidence-manifest hash;
* generated receipt PDF hash and private storage key;
* evidence-signing key ID and cryptographic signature.

The receipt PDF consists of the immutable source PDF followed by a UOA-generated
certificate page. UOA must not rewrite the source PDF bytes or attempt arbitrary signature
placement in Phase 1. The certificate page contains the agreement/version identifiers,
signer details, signing method, acceptance timestamp, source hash, evidence-manifest hash,
and public verification reference. The final receipt PDF hash is calculated only after
the certificate page is appended, then stored on the signature record and returned by the
verification endpoint; it is not embedded into the PDF it hashes.

UOA also creates a canonical JSON evidence manifest and signs it with a dedicated
evidence-signing key. Config-signing, access-token, admin-token, shared-secret, and email
token keys must not be reused. The signature includes a `kid` so historical receipts can
still be verified after key rotation.

This service-signed evidence proves the integrity of the UOA record. Phase 1 must not
claim to produce a qualified electronic signature, a PAdES signature, a trusted timestamp,
notarisation, or a jurisdiction-specific legal guarantee.

## Current-Requirement Evaluation

For an enabled domain, a user is complete only when a non-revoked signature exists for
every active required AgreementVersion on that domain.

Evaluation rules:

* Always read current domain settings and current published versions server-side.
* Match on `userId + domain + agreementVersionId`; never accept a client-supplied
  `complete` flag.
* A superseded version does not satisfy its replacement.
* A revoked signature remains visible as history but does not satisfy the requirement.
* A new valid signature after revocation creates a new record; it never overwrites the
  revoked record.
* The final completion check and authorization-code issuance must be protected against a
  policy-change race. If the policy revision changed, re-evaluate before issuing.

Phase 1 adds no signature list or personal evidence to access-token claims. Successful
authorization-code or refresh issuance is itself the current-access decision; consuming
applications that need detail use the protected status API.

## Refresh Tokens and Policy Changes

The signature gate applies to refresh-token rotation as well as interactive authorization:

* Before issuing a refreshed access token, re-evaluate the domain's current signature
  requirements for the refresh-token user.
* If a required signature is missing or revoked, do not rotate or consume the valid
  refresh token. Return the normal OAuth failure that tells the client to restart an
  interactive authorization flow, where signing can occur.
* Publishing a new required version therefore blocks the next refresh and forces
  interactive reauthentication/signing.
* Already-issued stateless access tokens remain valid until their normal short expiry.
  Phase 1 does not add immediate mid-token revocation for policy publication.
* When the signature service is disabled, refresh behaviour is unchanged.

## Revocation

Admin operators may revoke a signature with a required reason. Revocation is a new
append-only record containing the signature ID, actor, reason, and timestamp; the original
signature and receipt are never modified or deleted.

Revocation makes the user incomplete for that AgreementVersion. It blocks the next
authorization or refresh decision and requires a new signature in an interactive flow.
Revocation does not invalidate an already-issued access token before its ordinary expiry.

## Storage and Data Model

Add focused models rather than a generic policy engine:

```text
ClientDomain
  └── DomainSignatureSettings
        └── Agreement
              └── AgreementVersion

User + Domain + AgreementVersion
  └── AgreementSignature
        └── SignatureRevocation

SigningContinuation
SignatureAuditEvent
```

Required implementation rules:

* PostgreSQL/Prisma stores metadata, state, hashes, and audit records.
* Source and receipt PDFs live in durable private object storage, never a public bucket
  and never as large database blobs.
* Object access uses short-lived, purpose-bound URLs or authenticated streaming.
* Published files, signatures, revocations, and signature audit events are append-only.
* Draft versions with no signatures may be deleted. Published versions and evidence may
  not be cascade-deleted with a domain or user.
* Deleting a domain or user must not silently destroy retained legal evidence. The delete
  operation is blocked while retained signature evidence exists unless a separately
  approved retention/deletion workflow has handled it.
* All queries are scoped by verified domain and, for user reads, authenticated user ID.
* Admin-only tables use the same deny-by-default/BYPASSRLS pattern as other Admin-owned
  domain settings until a narrower tenant-admin boundary is specified.

## Admin Experience

The existing Admin domain detail page gains an **Agreements** tab. Phase 1 is managed by
platform superusers; it does not invent a separate customer-admin identity or portal.

The tab must support:

* current enabled/disabled state;
* active requirement summary and policy revision;
* agreement list and display order;
* PDF upload, preview, source hash, and draft editing;
* signing-method and acceptance-statement configuration;
* publish, supersede, and withdraw actions with explicit confirmation;
* signature search by user, agreement, version, and date;
* receipt download and verification details;
* signature revocation with a required reason;
* audit history for settings, publication, withdrawal, and revocation.

The enable toggle remains unavailable until at least one valid published required version
exists. Destructive or access-changing actions must use confirmation dialogs and create
Admin audit events.

## Required API Surface

Exact request/response schemas are defined during implementation, but the route families
and authorization boundaries are fixed:

* `/signatures/session/*` — capability-token access used only by the hosted signing flow;
* `/signatures/me/*` — authenticated signer status and receipt access, restricted to the
  access-token subject and domain;
* `/signatures/verify/:reference` — public, PII-minimised receipt integrity check;
* `/domain/signatures/*` — domain-backend status reads using the established domain-hash
  auth and verified config boundary;
* `/internal/admin/domains/:domain/signatures/*` — platform-superuser settings,
  agreement/version management, signature search, receipt download, and revocation.

The public verification response exposes only the reference state, agreement/version
identifiers, source and receipt hashes, signing timestamp, evidence `kid`, and whether the
signature has been revoked. It must not expose signer name, email, IP address, user agent,
or internal user ID.

When any endpoint is added or changed, update both the machine-readable `/api` schema and
the `/llm` integration guide in the same implementation change.

## Security and Privacy Requirements

* Verify the domain and redirect using the existing config/public-client trust boundary
  before creating a signing continuation.
* Enforce CSRF protection on browser mutations and replay protection on continuation and
  submission tokens.
* Treat all client-submitted agreement IDs, version IDs, hashes, names, and completion
  flags as untrusted.
* Validate uploaded files as PDFs, enforce a bounded documented size limit, malware-scan
  them, and render them without executing embedded scripts, actions, or external content.
* Use a restrictive CSP and do not expose private object-storage URLs permanently.
* Never log PDFs, typed names, capability tokens, raw evidence manifests, or signed URLs.
* Redact continuation and signature tokens using the same logging discipline as existing
  auth tokens.
* Make signing submissions idempotent so browser retries cannot create contradictory
  evidence or issue multiple authorization codes.
* Rate-limit session reads, signing submissions, public verification, Admin search, and
  uploads separately.
* Record privileged Admin changes and receipt access.
* IP address, user agent, signer name, and email are personal data. They must be covered by
  an explicit domain retention period and access policy before the service is enabled.
* Customer contract wording and the legal sufficiency of click-wrap or typed-name
  signatures remain the customer's responsibility.

## Error and Enumeration Rules

* Before authentication, preserve the existing generic auth and anti-enumeration rules.
* An invalid, expired, or consumed signing continuation returns one generic restart
  message and never reveals which agreement, user, or signature exists.
* Once the user is authenticated inside a valid signing continuation, the UI may explain
  exactly which document and confirmation remain incomplete. This is required workflow
  guidance, not an account-existence disclosure.
* Admin validation errors may be specific because the caller is an authenticated platform
  superuser.

## Explicit Non-Goals

Phase 1 does not include:

* KYC or external identity-verification providers;
* proof of address, age, liveness, biometrics, sanctions, or PEP screening;
* business verification;
* phone verification;
* manual access approval or risk scoring;
* generic forms, evidence uploads, training, quizzes, or certificates;
* role-, group-, organisation-, App-, plan-, invitation-, feature-, or transaction-specific
  policies;
* step-up signing for an individual product feature;
* drawn signatures;
* multi-party, sequential, or countersignature workflows;
* document authoring, templates, merge fields, or generated commercial contracts;
* qualified signatures, PAdES, trusted timestamp authorities, or notarisation;
* webhooks or an SDK-level policy engine;
* a customer self-service administration portal.

These capabilities require separate briefs. They must not be introduced as hidden
abstractions while implementing this module.

## Delivery Phases

### Phase 1A — Domain and Agreement Foundation

* Prisma models and migration;
* private file-storage adapter and evidence-signing key configuration;
* Domain Admin Agreements tab and settings endpoints;
* draft upload, PDF safety checks, hashing, publication, superseding, and withdrawal;
* Admin audit events.

### Phase 1B — Auth Gate and Signing UI

* shared signature evaluation service;
* signing continuations;
* Auth UI document viewer, click-wrap, and typed-name flows;
* integration with every authorization-code issuance path;
* refresh-token enforcement;
* re-evaluation on concurrent policy change.

### Phase 1C — Evidence and Operations

* immutable signatures, revocations, and signature audit events;
* canonical evidence manifest, dedicated cryptographic signature, and receipt PDF;
* signer receipt access, domain status API, Admin search/download, and public
  PII-minimised verification;
* retention/pruning implementation after the retention decisions below are resolved;
* complete `/api` and `/llm` documentation.

## Success Criteria

1. A domain with the module disabled has the same authorization and refresh behaviour as
   before this module existed.
2. Enabling the module for domain A does not change domain B.
3. An Admin can upload, inspect, hash, and publish a PDF without a client-app code change.
4. An authenticated user missing a required signature cannot receive an authorization
   code or refreshed access token for the enabled domain.
5. A user can sign the missing versions and return to the exact validated OAuth
   continuation successfully.
6. UOA can reconstruct the exact PDF hash, acceptance statement, method, user, domain,
   time, auth method, and 2FA state associated with a signature.
7. Published versions and signature evidence cannot be edited or silently deleted.
8. Publishing a new required version forces signing on the next authorization or refresh
   without invalidating already-issued short-lived access tokens.
9. Revocation preserves history and forces a new signature at the next gate.
10. The public verification endpoint can validate receipt integrity without exposing PII.
11. Password, social, email-link, email-code, workspace-selection, and public-client OAuth
    paths all enforce the same gate.

## Decisions Required Before Implementation

The following choices are intentionally not guessed in this brief and must be resolved
before Phase 1 implementation begins:

1. **Evidence retention:** required domain-level retention range and default, deletion
   timing, legal-hold needs, and what happens when a user or domain is deleted.
   **Local Phase 1 resolution:** an explicit value from 1 to 36,500 days is required and
   there is no silent default. Phase 1 treats evidence as retained, append-only data and
   blocks user/domain deletion while it exists. It does not automatically erase evidence;
   time-based deletion and legal holds require the separately approved deletion workflow
   described above before production use can promise automatic expiry.
2. **Object storage:** the production private object-storage provider, bucket residency,
   backup policy, and encryption-key ownership.
   **Local Phase 1 resolution:** private filesystem storage is supported only for local
   development and tests; production rejects it and requires the private GCS adapter.
   Bucket residency, backup, and encryption-key ownership remain deployment controls.
3. **Evidence key custody:** where the dedicated private signing key is held, rotation
   interval, and how retired public keys remain available for verification.
   **Local Phase 1 resolution:** evidence uses its own RS256 private JWK supplied through
   the deployment secret boundary. Verification uses a public-only JWKS containing the
   current and retired keys by `kid`. Custody and rotation cadence remain deployment
   controls and the service cannot be enabled without both key inputs.
4. **Upload limits:** maximum source-PDF size and page count.
   **Local Phase 1 resolution:** defaults are 25 MiB and 200 pages, with bounded deployment
   overrides of 1 KiB–100 MiB and 1–2,000 pages.
5. **Signer name:** whether typed-name signatures require the existing profile `name`,
   permit an entered legal name, or require the two values to match.
   **Local Phase 1 resolution:** the signer enters a name of up to 200 characters. It is
   captured as the user's assertion and is not matched to or described as verified by the
   profile name.
6. **Legal review:** the jurisdictions and assurance claims the product may advertise.
   Until reviewed, product copy must describe this as authenticated agreement evidence,
   not a qualified or independently verified signature.
   **Local Phase 1 resolution:** no jurisdiction-specific assurance is claimed. Auth UI
   and receipt copy use “authenticated agreement evidence” and explicitly disclaim
   qualified-signature, notarisation, trusted-timestamp, and independent-ID claims.
