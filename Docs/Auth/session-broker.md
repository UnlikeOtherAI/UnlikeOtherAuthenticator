# Coder to Selkie session broker

UOA remains the authentication authority. Coder exchanges a fresh RS256 subject assertion
with current `tv` and active org/team at `/auth/token`. Only `session:broker`, product
`coder`, source `coder.unlikeotherai.com`, and resource `https://api.selkie.live` are allowed.
The existing five-minute RS256 resource-token profile and `/oauth/jwks.json` apply.
Chained grants and team-less assertions are refused.

An operator must register an enabled mapping for this exact source/product/resource and
only this scope. The vocabulary migration creates no mappings and widens no old mapping.
Absent or disabled mappings fail closed. Deploy UOA before configuring the mapping and
updating both relying products; source merge alone does not provision production.

Selkie authenticates with its verified configuration and domain bearer and posts
`{token}` to `/auth/session-broker/validate`. Only target domain `api.selkie.live` is
accepted. UOA checks the signature, audience, direct provenance, expiry, scope, current
source mapping, epoch, source domain role and active team. The response is
`{sub,expires_at,active:{orgId,teamId}}`, with RFC3339 expiry. No caller profile is trusted.
Selkie reads canonical profiles separately and stores only a sealed capability/reference.
Each broker-backed request revalidates; the local opaque handle expires no later than
the capability and clients rebroker automatically. This path grants no refresh family
or debug code. Browser debug redemption still issues an independent UOA refresh family.

Source logout prevents further renewal. An already issued delegated capability remains
valid for at most five minutes, subject to current epoch, membership and mapping checks.
Register the new scope through the operator API; no mapping is created by deployment.

Selkie admission additionally requires a current Selkie domain role and the same active
team admitted by Selkie’s server-owned product policy. The source mapping does not
create target membership. Existing cross-product policy requires a current Selkie
customer-lifecycle registration; absent or revoked registration refuses the broker.
Selkie’s product-specific suspension rules remain enforced by its local session handler.
Database outages fail closed and remain retryable errors, rather than proven revocation.
