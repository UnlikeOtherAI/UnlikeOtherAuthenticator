# Directory change webhooks

UOA remains the authority for human profiles and organisation/team memberships.
Products receive reference-only notifications and read the changed subject from
UOA under the current reader's authority. No profile copy is needed in a product
database or an event log.

An operator sets `DIRECTORY_WEBHOOK_TARGETS_JSON` to an array of objects with
`domain`, `url` and `secret`. Use one HTTPS destination per registered product
domain and a dedicated random secret of at least32 characters. Store this setting
in Secret Manager; never put production values in source, logs, user settings or
signed public product configuration. This is server configuration, not a new
public subscription-management capability.

For Nessie, use its exact configured `UOA_DOMAIN` and destination
`https://api.nessie.works/api/auth/uoa/directory-webhook`. Configure the same
secret as `UOA_DIRECTORY_WEBHOOK_SECRET` on Nessie. Do not reuse a domain bearer,
user token or signing key. HTTPS redirects are refused.

Database triggers enqueue one event per affected organisation/team/subject when
a profile, uploaded avatar, organisation membership or team membership changes.
The audience includes the organisation’s source domain and unambiguous active
product mappings with direct access evidence for that exact organisation/team,
so a team reused across products reaches each participating product without
notifying unrelated domains. The event commits with the source mutation,
including invitations accepted and
changes made through Admin or other products. Newly created users become visible
when their team membership commits. The outbox contains ids and delivery state
only. App-role callers cannot read it; the administrative delivery worker leases
pending events across replicas and retries failures with capped backoff. Events
for unconfigured domains remain pending so later registration can recover them.

The worker sends JSON:

```json
{"id":"event-uuid","type":"person.changed","version":1,"occurredAt":"2026-10-22T12:00:00.000Z","domain":"app.example.com","organizationId":"org-id","teamId":"team-id","subject":"person-subject"}
```

`X-UOA-Timestamp` is the delivery's current Unix time in seconds.
`X-UOA-Signature` is the lowercase hexadecimal HMAC-SHA256 of the exact UTF-8
bytes `<timestamp>.<body>`, keyed with that product's dedicated secret. Receivers
verify raw bytes and at most five minutes of clock skew before parsing, validate
the exact domain and mapping, and deduplicate the stable event id. Retries retain
the event id and occurrence time but use a fresh delivery timestamp/signature.
Any 2xx response acknowledges delivery. Failures retain the pending event.

The precise read reuses the current
`GET /org/organisations/:orgId/teams/:teamId/members` API with
`subject_ids=<comma-separated stable subjects>&status=all&limit=100`. A request
contains at most100 subjects. It retains the existing original-assurance actor
proof, verified config, current exact-team authorization and field privacy.
Missing subjects are omitted; historical membership rows retain lifecycle status.
The caller never substitutes a full roster read for this selected-subject read.
Only the provider's current manager permissions authorize disclosure of email.
The signed-in person's own canonical profile continues to use `/org/me`.

Deploy this outbox and configure notification delivery alongside the existing
reviewed UOA authority rollout. Profile/hierarchy cleanup uses that rollout’s
read-only inventory and reviewed apply; this webhook change never bypasses it. Deploy and configure both ends, then verify an actual UOA rename and
membership addition/removal against eligible open product views. Unit and
synthetic signed-webhook tests establish the protocol behavior; they do not prove
production registration or cross-device delivery.

`GET /org/organisations/:orgId/teams/:teamId/people/:userId/avatar` uses the same
existing selected-subject authorization and renders the target's current picture without
requiring a domain-role row on the product. This covers newly added people who
have never signed into that product. Products relay these authenticated bytes;
browsers do not receive a domain credential.
