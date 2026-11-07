# Ledger portfolio validation failure — 7 November 2026

Production UOA source `2694c8088a18525f68589d5516074020856d1db9` reported
`LEDGER_METERING_PORTFOLIO_RESPONSE_INVALID` for request `req-5cv` around
21:46:19 UTC. Trace:
`projects/gen-lang-client-0561071620/traces/a5ba0ec0d35cf20d7870746adf34634a`.
That generic error covers validation and scope mismatches; it did not prove a
November billing hold.

Parent-owned read-only runtime probes imported the actual deployed collector
schema from image
`sha256:6d8ec9248f9c6636c32bbd86c8f155df1c5d31d01867a34899a3e307b961b945`.
All eight existing November credit scopes returned HTTP 200 and all seven exact
product/group/organisation/team/month/start/end equality checks were true.
Seven parsed successfully. Original scope index 2 failed only at:

- `totals.usageByService[6].rawProviderUsage.breakdown`: `unrecognized_keys`
- `breakdown[7].rawProviderUsage.breakdown`: `unrecognized_keys`

The bounded follow-up identified exactly `cacheWrite30mTokens` and
`cacheWrite12hTokens`. The Ledger producer on main
`23472669c817fd771bc353894193d1bfa628fc35` includes both in
`api/src/repositories/metering-usage-aggregate.ts`. UOA's strict breakdown
allowlist omitted them. This is a consumer schema compatibility failure, separate
from mode, scope or the monthly reconciliation hold.

The correction admits only these two additional optional unsigned integer-string
facts and preserves them through normalization. Negative, fractional, exponent,
numeric and other non-string values remain invalid. Arbitrary unknown breakdown
keys and commercial fields remain rejected. No passthrough, monetary default,
customer-payload capture or relaxation of account/scope/financial guards is used.
Focused regressions verify both totals and detailed breakdown validation, exact
large integer preservation and rejection of malformed/unknown fields.

Sanitized probe evidence remains outside worktrees:
`D:/BuildArtifacts/nessie/organisation-billing-usability-20261107/ledger-contract-probe-sanitized.json`
and `ledger-contract-probe-field-names.json`. Recorded response digests:
`87efea535a514a0246cce9e59a0cd0135e9a190b3d630e302cb5e383a6955b90`
and `cb76685f795bb67380eb0cad2dabb914383c7dff1b22f2739022e074fd5cf3da`.
Only issue paths/codes, field names, scope equality booleans and digests were
reported; no raw response or secret was persisted or logged. Parent removed the
temporary diagnostic job and specification; service/readiness configuration was
not changed. The source correction still requires the normal reviewed UOA deploy.
