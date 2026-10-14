# Directory authority: deliberate machine-only provisioning

This release supports operator/owner provisioning through the documented HTTP
API. It deliberately supplies no Admin or product settings UI. The supported
doorway is an approved operator API client and the product owner's authenticated
BFF, using the existing UOA sign-in flow. `/api` publishes the complete contract;
`/llm` links this procedure. Never provision an implicit grant or store a second
identity/org hierarchy in a consuming product.

1. A current Admin-domain SUPERUSER signs in through the existing Admin login.
   Their short-lived Admin bearer authorizes
   `POST /internal/admin/directory-credentials` with `client_domain_id`, `label`
   and an explicit ISO `expires_at` (future, at most90days). Ordinary app-scoped
   Admin API keys cannot provision directory authority. The registered product
   domain must be active. This operation creates no organisation permission.
2. The approved operator client captures the one-time `secret` response directly
   into the product backend's approved secret manager. Keep it out of browser
   storage, URLs, shell arguments/history, logs, tickets and durable API traces.
   List credentials through `GET` on the same path: only bounded metadata and
   prefixes are returned. A lost issuance response may have committed; inspect
   metadata, revoke the unused credential, and issue a replacement.
3. The canonical organisation owner signs in normally to the consuming product.
   Their BFF calls `PUT /org/organisations/:orgId/product-access/:credentialId`
   with the verified product `domain`/`config_url`, domain bearer and exactly one
   current `X-UOA-Access-Token` or short-lived `X-UOA-Subject-Assertion`. The actor
   must currently be the exact org owner with ACTIVE owner membership. Body
   `permissions` explicitly selects `MEMBERSHIP_READ` and/or `DISPLAY_READ`.
   `WEBHOOK_MANAGE` is reserved and enables no delivery API in this release.
   `GET /org/organisations/:orgId/product-access` reviews current exact-org grants;
   `DELETE .../:credentialId` revokes one. There is no backend-only owner bypass.
4. The product backend uses the separate `uoa_dir_` bearer for live standing,
   minimal display and image reads under `/directory/v1/organisations/:orgId/subjects`.
   Grants and credential/domain state are checked on every read. Images require
   the same credential; proxy authorized bytes through the BFF. No person session,
   self-profile write, other-person email or implicit org membership is granted.
5. Rotate with `POST .../directory-credentials/:credentialId/rotate` and explicit
   `overlap_seconds` from0 through600. Securely install the new one-time secret,
   verify a live read, and retire the prior secret by the returned overlap expiry.
   `POST .../:credentialId/revoke` with `{}` revokes the whole credential. Operator
   credential revocation and owner permission revocation preserve person sessions.

All responses, including failures, are private/no-store. Treat401/403 as refused
directory authority; preserve existing person sessions on dependency503/500.
An oversized standing result returns503 rather than a misleading partial list.
Profiles may use bounded memory only. U2 revisioned snapshots/deltas/webhook
delivery are not provided, so this provisioning procedure does not authorize a
durable directory cache or Nessie identity cutover. N03 remains blocked until U1/U3
runtime acceptance and the consuming contract are verified.
