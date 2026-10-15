# Profile/directory TCP authority gate — 832c4eca

Maxis serial runner, one worker, heap3072MiB; real owned PostgreSQL16. One local
API TCP listener on an ephemeral loopback port, closed by fixture teardown.
All6tests pass,63.79seconds, exit0. Real uoa_app login is asserted non-BYPASSRLS;
configured production-role clients are uoa_app/uoa_admin, with bootstrap seeding
separate from API handling. No production/provider operation.

- RS256 same-host-JWKS subject assertion: canonical GET/PATCHself, read-only email,
  pronouns, stable subject, no duplicate user creation, atomic revision1 invalidation.
- Actual multipart upload and exact authenticated profile avatar bytes, no-store,
  nosniff; anonymous read denied.
- Nullable ACTIVE name, exact retained historical organisation reference, neutral
  unknown/erased/avatar404 over TCP.
- Actual PostgreSQL lock waiter observed; user token expiry after wait refuses401
  without profile/outbox mutation.
- Operator issuance and exact owner grant over TCP; independent permission refusal;
  directory secret expires after actual PostgreSQL lock wait and refuses401.
- Actual uoa_admin schema-permission outage remains generic500/private-no-store.

Schemas retained. Listener/runner closed with no compiler children. This strengthens
U3 and the U1 directory doorway; full113-writer runtime and remaining races are not
certified. N03 remains blocked on complete U1/U3 acceptance.
