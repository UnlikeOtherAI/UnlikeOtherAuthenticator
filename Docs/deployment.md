# Deployment across the UOA product estate

How every product that uses this SSO actually reaches production, where it runs, and what to check
when a change is on `main` but not live.

Scoped to deployment. UOA's own Cloud Run specifics — env vars, migration behaviour, rollback —
stay in [`deploy.md`](./deploy.md); this file says how each *product* ships and how they relate.

Written 2026-08-06 from the running systems, not from memory: workflow definitions on each
`origin/main`, `gh run list` history, and the server itself. Re-verify before trusting it — the
"How to check" sections exist so you can.

---

## The two halves

**UOA (this repo) runs on Google Cloud.** Cloud Run service `uoa-auth`, fronted by
`authentication.unlikeotherai.com`, with Cloud SQL `gen-lang-client-0561071620:europe-west1:uoa-auth-db`.
Pushing to `main` triggers [`deploy-main.yml`](../.github/workflows/deploy-main.yml), which builds,
migrates and shifts traffic. `authentication.unlikeotherai.com` resolves to `ghs.googlehosted.com` —
if you are looking for its database on the product server, it is not there.

**Every consuming product runs on one Hetzner box: `178.105.82.46`.** Each is a Docker Compose
stack on shared `edge` (Caddy) and `db` networks, with product sources under `/srv/<product>/`.
Several databases share one `postgres` container; a few products run their own
(`nessie-postgres`, `docgen-postgres`).

The consequence worth internalising: **a UOA feature is not usable until the product redeploys.**
Capabilities are carried in each product's signed config JWT, which UOA fetches from that product's
live host. Ship a flag to a product's `main`, leave the product undeployed, and UOA keeps reading
the old config and correctly behaves as though the flag does not exist.

---

## Per-product deployment

| Product | Repo | Trigger | Mechanism |
| --- | --- | --- | --- |
| UOA | `UnlikeOtherAuthenticator` | push to `main` | GitHub Actions → Cloud Run `uoa-auth` |
| Nessie | `Nessie` | push to `main` (`deploy.yml`) | GitHub Actions → SSH to Hetzner → `deploy.sh` |
| DeepWater | `water` | push to `main` (`deploy.yml`) | GitHub Actions → SSH → `docker compose` |
| DeepSignal | `deepsignal.live` | push to `main` (`deploy.yml`) | GitHub Actions → SSH → `docker compose` |
| AdGoes | `AdGoes.live` | push to `main` (`deploy.yml`), `paths-ignore` docs | GitHub Actions → SSH → `docker compose` |
| DeepTest | `DeepTest` | push to `main`, **gated on full CI** | `deploy` job inside `ci.yml` → hardened receiver |
| DocGen / BuildMe | `docgen` | push to `main` (`deploy.yml`) | GitHub Actions → SSH → `/srv/docgen/deploy/server/ci-receive.sh` |

`buildme.live` has no deployment: it is docs and an iOS prototype, with no API. The product behind
the BuildMe name is `docgen`.

### DocGen control-plane registration

Before enabling DocGen paid inference or its Billing screen, a UOA superuser
must register the canonical product identifier `docgen` as an active Billing
Service through `/internal/admin/billing/services`, with its initial immutable
tariff, **before** the next Stripe-catalog provisioner invocation. The
provisioner intentionally fails closed while the service is absent, then
requires it beside Nessie, DeepWater, DeepSignal, and DeepTest; this does not
alter runtime billing merely by deploying UOA. It does not create a service,
tariff, Stripe product, or Price on an operator's behalf.

After the `buildme.live` client domain is active, create exactly one enabled
confidential-delegation mapping with `source_domain=buildme.live`,
`product=docgen`, `resource=https://ledger.unlikeotherai.com`, and only
`scopes=["ai.invoke"]`. UOA rejects a DocGen mapping that points at a different
resource, domain, or scope. The deployment also needs its own
`customer_lifecycle` UOA app key, bound to DocGen's independently generated
RS256 actor public JWK and its exact HTTPS return origin(s). Store that key and
private signer only in DocGen's backend secret store; it is distinct from the
Ledger runtime `lk_…` key, the UOA-to-Ledger collector key, all provider keys,
and every other product's app key.

The UOA Billing Service, delegation mapping, and app key are operator state,
not seed data. They must be provisioned before a DocGen deployment serves the
new configuration; UOA being deployed alone cannot make the product live.

### SalesNerd Ledger delegation

SalesNerd uses its own product credit allowance and does not currently enroll
in UOA customer billing. UOA accepts `salesnerd` in the raw Ledger metering
schemas so its product attribution does not invalidate a usage or portfolio
response. That acceptance does not create a UOA Billing Service, tariff, billing
app key, Stripe catalog entry, or customer charge; those are separate
commercial enrollment decisions and remain absent until explicitly requested.

After the `app.salesnerd.live` ClientDomain is active and its config JWKS is
serving the current assertion-signing key, create exactly one enabled
confidential-delegation mapping with `source_domain=app.salesnerd.live`,
`product=salesnerd`, `resource=https://ledger.unlikeotherai.com`, and only
`scopes=["ai.invoke"]`. UOA now enforces that exact tuple in code, like
DocGen's Ledger binding. The exchanged UOA access token has `azp` and
`source_domain` equal to `app.salesnerd.live`; `product=salesnerd` remains a
separate claim. This mapping is operator state and is not seeded or created by
deploy.

### The two hardened receivers

DeepTest and DocGen do not take a general root shell. Their CI keys are pinned in
`/root/.ssh/authorized_keys` with forced commands:

- `/usr/local/sbin/deeptest-github-deploy`
- `/srv/docgen/deploy/server/ci-receive.sh`

DeepTest's is the strictest in the estate and worth reading before touching it
([`DeepTest/docs/deployment.md`](/Volumes/External/Projects/deeptest/docs/deployment.md), "Routine
release"): it requires a GitHub Actions OIDC token bound to the repository, workflow, `production`
environment, branch, event and release SHA; keeps a replay ledger of used token ids; stages
credentials outside the source tree; tags images with the seven-character SHA; runs a signed UOA
customer-lifecycle canary; and rolls back source, containers, Caddy block and credentials together
if any step fails.

The other products' workflows SSH in and drive `docker compose` directly.

---

## When `main` is not what is running

This happens, and it is the first thing to check when a change "did not work".

```bash
# What each product actually serves — the config JWT is the source of truth for UOA behaviour
curl -fsS https://api.deeptest.live/auth/config | cut -d. -f2 | tr '_-' '/+' \
  | python3 -c "import sys,base64,json;s=sys.stdin.read().strip();s+='='*(-len(s)%4);\
d=json.loads(base64.b64decode(s));print(json.dumps(d.get('org_features'),indent=2))"
```

```bash
# Has this product deployed since the commit you care about?
gh run list --workflow deploy.yml --branch main --limit 5 \
  --json conclusion,createdAt,displayTitle
```

```bash
# What image is the host running?
ssh root@178.105.82.46 'grep IMAGE_TAG /srv/<product>/source/deploy/.env; \
  docker ps --filter name=<product> --format "{{.Names}}\t{{.Image}}\t{{.Status}}"'
```

A green deploy tick is not proof. Decode the served config — that is what UOA reads.

### Known failure modes, seen in practice

- **A red gate silently freezes deployment.** DeepTest's deploy job `needs: build`, and `build`
  included a Playwright browser suite. With 32 of those failing, the host sat 75 commits behind
  `main` for days while every merge looked successful in the repo, and it happened again from
  2026-09-10 for two weeks. Nothing warns you; the deploy job simply never runs. The browser suite
  has since left the deploy gate (it runs by hand), but any failing required step does the same.
- **One lint error blocks everything.** AdGoes' deploy failed on a single `no-empty` violation in a
  test file and stayed broken for ~2 months, so config changes merged to `main` never shipped.
- **A push may not trigger the run.** Observed on AdGoes: a push to `main` produced no workflow run
  at all. `gh workflow run deploy.yml --ref main` dispatches it manually where the workflow declares
  `workflow_dispatch`.
- **`paths-ignore` skips deploys.** AdGoes ignores `**.md` and `Docs/**`, so a docs-only commit
  deliberately does not deploy. Correct, but confusing if you expected a run.

---

## Manual deploy (Hetzner products)

Use only when the pipeline is blocked and the change must ship. It **bypasses** whatever safety the
normal path provides — for DeepTest that means the OIDC binding, the UOA canary, the Caddy re-render
and automatic rollback. Prefer fixing the pipeline.

The stack's Compose project name comes from the directory holding `compose.yml` (`deploy` for
DeepTest). Build from a path with a different basename and you create a *second* project running
duplicate containers against the same networks. Replace the source in place instead:

```bash
# 1. Archive the commit and stage it, preserving the live .env (it points at staged secrets)
cd <repo> && git archive --format=tar origin/main -o /tmp/<product>-main.tar
scp /tmp/<product>-main.tar root@178.105.82.46:/tmp/
ssh root@178.105.82.46 'mkdir -p /srv/<product>/source-new && \
  tar -xf /tmp/<product>-main.tar -C /srv/<product>/source-new && \
  cp /srv/<product>/source/deploy/.env /srv/<product>/source-new/deploy/.env'

# 2. Build with the target SHA as the tag — running containers are untouched until step 3
ssh root@178.105.82.46 'cd /srv/<product>/source-new && \
  sed -i "s/^.*IMAGE_TAG=.*/<PRODUCT>_IMAGE_TAG=<sha7>/" deploy/.env && \
  docker compose --env-file deploy/.env -f deploy/compose.yml build'

# 3. Swap the source aside (keep it — it is the rollback) and recreate
ssh root@178.105.82.46 'cd /srv/<product> && mv source source-prev-<oldsha> && \
  mv source-new source && cd source && \
  docker compose --env-file deploy/.env -f deploy/compose.yml up -d --no-build'

# 4. Verify — health, then the served config
ssh root@178.105.82.46 'docker ps --filter name=<product> --format "{{.Names}}\t{{.Image}}\t{{.Status}}"'
```

**Rollback:** the previous images stay on the host. Point the tag back and recreate without
building:

```bash
ssh root@178.105.82.46 'cd /srv/<product>/source && \
  sed -i "s/^.*IMAGE_TAG=.*/<PRODUCT>_IMAGE_TAG=<oldsha>/" deploy/.env && \
  docker compose --env-file deploy/.env -f deploy/compose.yml up -d --no-build'
```

A manual deploy is **not** a divergence from source as long as you deploy a commit that is already
on `main`: the next successful pipeline run ships the same code and converges. It is a way to make
the server catch up, never a way to run something `main` does not contain.

---

## Database access

UOA's database is Cloud SQL, reachable through the Auth Proxy without opening the instance to your
IP. The instance has an authorized-networks allowlist; use the proxy rather than adding yourself.

```bash
cloud-sql-proxy --port 5434 --token "$(gcloud auth print-access-token)" \
  gen-lang-client-0561071620:europe-west1:uoa-auth-db
```

Credentials live in Secret Manager: `uoa-auth-database-admin-url` (the `uoa_admin` BYPASSRLS role,
needed for anything crossing tenants) and `uoa-auth-database-url` (`uoa_app`, RLS-bound).

**The billing tables defend themselves.** `billing_credit_accounts` is immutable outside a
balance/auto-top-up whitelist and refuses `DELETE` as commercial history; portfolio snapshots are
append-only; credit accounts and Stripe customers must agree on `org_id`, `team_id`, scope `TEAM`
and a derived `scope_key` of `org_id || ':' || team_id`. Data surgery that moves organisations will
hit these in sequence. They are deliberate — do not disable them without saying so out loud.

Product databases live on the Hetzner host, most inside the shared `postgres` container:

```bash
ssh root@178.105.82.46 'docker exec postgres psql -U postgres -tAc \
  "SELECT datname FROM pg_database WHERE datistemplate = false"'
```

## Entity deletion adapter deployment (2026-10-03)

Deploy the forward lifecycle migration before the API/Admin release. No production erasure is part of development or migration. Back up and exercise the deployment in staging. Registered products need an adapter for GET `/domain/deletion-jobs?domain=<exact identity>` and POST `/domain/deletion-jobs/:id/acknowledge?domain=<same identity>` using that product's existing domain bearer. Process effectiveScope/effectiveTargetId and committed accountsToDelete; persist idempotent job revision handling. Acknowledge PURGED only after content cleanup commits, or RETAINED_EVIDENCE when restricted records remain. Never treat receipt as purge. UOA holds the entity/candidates terminal while awaiting acknowledgement. The API/Admin build alone does not install adapters elsewhere; outstanding participants remain visible and block completion. Lifecycle changes require live checks in consuming products; offline access tokens remain valid until their bounded expiry absent introspection/revocation integration.

Deletion jobs use a two-minute renewable executor lease and commit at most20 local cleanup stages per retry. READY means additional stages remain; repeat the authenticated retry endpoint until COMPLETE or a visible blocker. Each audit stage processes at most100 matching operational records and atomically saves its cursor. A restarted executor waits for an outstanding lease to expire, then resumes committed progress. Products return optional bounded retained-evidence summaries (label/count/reason, no unrelated PII); absent summaries are explicitly unavailable. Billing access inventory derives the exact registered HTTPS host from the actual app key actor issuer, including revoked access history; a product label is not an authority. Never-recorded product use cannot be inferred from UOA: operators must reconcile missing registrations/history before declaring an estate-wide purge. Deployment of adapters and their cleanup policies remains external to this repository.

## UOA access-status diagnostics

The UOA auth service's `AUTH_ACCESS_STATUS_ENABLED` environment setting defaults
to `false`. Normal deployment omits “Check access status” from login and refuses
all website/native status-proof start/verify requests with 404 before side
effects. An intentional auth-server `true` opt-in retains the existing mailbox,
TOTP and membership/privacy checks. Changing it requires a restart/redeploy;
disabling also closes outstanding proof redemption. See [the environment example](deploy.md#access-status-diagnostic-environment-example).

### Operator provisioning of Ledger runtime keys

A current platform superuser opens Admin **Billing → Product billing → selected
product → Ledger runtime keys**. Review the exact product, original source config
domain (for Nessie production, `api.nessie.works`) and Ledger audience before issuing.
Transfer the one-time plaintext only to the approved Ledger deployment secret store;
the UI does not install it or restart Ledger. Do not reuse ordinary product app keys,
domain credentials, delegation tokens or another product's runtime key. Lists contain
metadata only; UOA cannot retrieve the plaintext later. If issuance response is lost,
inspect the list and revoke an unused key before issuing a replacement. Production
provisioning and installation remain deliberate operator actions.
