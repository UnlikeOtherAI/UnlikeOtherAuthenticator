# Corporate email-domain auto-enrolment

**Status:** Proposed — reviewed by Kimix
**Owner:** UnlikeOtherAI (UOA) Auth and organisation APIs
**Scope:** UOA-controlled membership; Nessie consumes the resulting UOA organisation/team membership through its existing SSO integration.

## Outcome

A corporate organisation owner proves control of `example.com` in UOA, then
chooses one or more of that organisation's teams (the workspaces a user sees in
the authenticator). A person who creates a **new** UOA account with a verified
`@example.com` identity is placed directly in those teams before their first
workspace chooser is rendered. This is direct, policy-based membership, not a
`TeamInvite` and not an email invitation token.

For Nessie, that means the UOA organisation and team memberships are already
present when UOA issues the first signed context; Nessie remains a relying party
and must not create a second copy of the person, organisation, or invitation.

## Why this belongs in UOA

The rule is about a verified human identity and the UOA organisation/team graph.
It therefore belongs in the identity authority, once, rather than in each
product. The current `registration_domain_mapping` is a signed, per-product
configuration convenience in `API/src/services/org-placement.service.ts`: it
maps one email domain to one target during a newly-created user's login. It has
no organisation-owner UI, no corporate-domain proof, no persistent audit model,
and cannot express a durable one-domain-to-many-team policy. It remains a
legacy compatibility path during rollout; it is not the model to extend.

## Product and security decisions

1. **Verified corporate domain, then rules.** Introduce a persisted corporate
   email-domain claim, owned by an organisation. A rule can only reference an
   active verified claim. The owner verifies a short-lived, random DNS TXT
   challenge at UOA's documented dedicated record name. UOA stores a hash of
   the challenge, not a reusable plaintext token. Reissuing a challenge
   invalidates the prior one; expiry, revocation, and transfer all stop new
   enrolments immediately.
2. **Exact domain matching.** Make `extractEmailDomain` the one canonical
   normaliser for both stored claims and verified identities; it already does
   IDNA/Punycode, lowercase, and a trailing-dot cleanup. A dedicated claim-input
   validator rejects `@`, display names, and invalid values before it reaches
   that helper. `example.com` does not match `contractor.example.com` or vice
   versa. No wildcard matching is introduced.
3. **One organisation per UOA client domain; many teams in it.** An active
   corporate domain claim can belong to only one organisation for a given UOA
   client domain. It can have any number of target-team rules in that
   organisation. The same company can make separately owned claims for another
   relying-party client domain, but it cannot cause a newly registered user to
   gain two active UOA organisations for one client domain. This respects the
   existing partial unique invariant on active `OrgMember(userId, domain)`.
4. **New accounts only.** Evaluate the policy after the user's email identity
   has been verified and only while establishing a newly-created UOA account.
   Do not re-run it on later login, refresh, identity-linking, or email changes;
   it must never undo a deliberate member removal or deactivation. Existing
   people are enrolled through the normal member/invite controls.
5. **Least privilege.** Version one grants active `member` membership at the
   organisation and each selected team. It never grants `owner`, `admin`, a
   guest flag, or a caller-selected custom role. Apply the team's configured
   default custom role only where the existing role model expressly permits it;
   if that default disappears in a race, use its specified graceful fallback of
   plain membership. A later proposal may add a separately authorised elevated
   workflow; it is not an option on this automation.
6. **A rule is an explicit approval for the target team.** New durable rules
   may target only an active team in their organisation whose `joinPolicy` is
   `APPROVED_DOMAIN`. This gate applies to this new mechanism; the existing
   signed-config mapping retains its documented legacy exception until retired.
   Reject a later switch of an actively rule-targeted team to another join
   policy; owners must remove or revoke the rule first. Team deletion removes
   its rules transactionally and records the lifecycle event.
7. **No pre-auth discovery.** The registration and login screens do not reveal
   whether an address/domain matches a corporate rule, any organisation name,
   or target teams. Rule results appear only through the normal authenticated
   workspace chooser and signed UOA context.
8. **Owner-controlled administration.** Creating a corporate domain claim,
   verifying/reissuing/revoking it, and changing its target teams are
   organisation-owner actions. This is intentionally stricter than ordinary
   member invites because it controls membership for future people. The Auth UI
   must not expose the controls to organisation admins or members in v1.

These decisions deliberately replace the aspirational multi-organisation and
automatic-admin language in `Docs/Requirements/roles-and-acl.md` with a safe,
implementable policy compatible with the live membership uniqueness constraint.
Update that requirement and the ReBAC research document as part of delivery so
they no longer describe a conflicting behaviour.

## Data model and database migration

1. Add `OrganisationEmailDomain` (name may change to match project naming)
   with `organisationId`, a normalised `emailDomain`, the derived UOA client
   `domain`, claim state (`PENDING`, `VERIFIED`, `REVOKED`, `EXPIRED`), the
   current challenge hash/expiry, verification timestamps, and actor metadata.
   The organisation relation has cascade deletion. Use an explicit partial
   unique index on `(domain, emailDomain)` **where state is `PENDING` or
   `VERIFIED`**, so concurrent owners cannot attach one corporate domain to two
   organisations under the same relying party but an expired/revoked claim can
   be re-claimed. Maintain the derived client domain by database trigger, as
   `OrgMember.domain` is maintained, rather than trusting application writes.
2. Add `OrgEmailDomainRule` with a required verified-domain claim and required
   `teamId`. Requiring a concrete team avoids nullable-unique-index ambiguity
   and makes a rule stable when the organisation's default team changes. Use a
   unique `(emailDomainClaimId, teamId)` index; enforce in service and database
   that the team belongs to the claim's organisation and remains eligible.
3. Add relations to `Organisation` and `Team`, RLS enablement/policies for the
   new tables, generated Prisma client types, and an append-only migration.
   Do not edit the historical migration which merely reserves
   `OrgEmailDomainRule` indexes. The current-claim index predicate is part of
   the migration contract; do not leave it to an ORM nullable unique.
4. Extend `OrgAuditLog` action and target unions for claim lifecycle, rule
   lifecycle, and `member.auto_enrolled` (for example,
   `email_domain_claim.verified` and `email_domain_rule.created`). System enrolment records have
   `actorUserId: null` and include only non-sensitive identifiers (claim, rule,
   user, team and authentication method), never a DNS challenge or raw email.
5. In the migration/backfill, validate existing organisation/team rows and
   active-member uniqueness before adding constraints. Follow the production
   migration pattern already used for the active-membership constraint: bounded
   `lock_timeout`/`statement_timeout`, a preflight that names capped offending
   rows, documented operator remediation and `migrate resolve` recovery, then
   a normal append-only Prisma migration. It must be safe on a populated
   production database.

## API and service design

1. Build a focused organisation-domain service behind the normal `/org/:orgId`
   route family. It owns normalisation, owner authorisation, DNS challenge
   creation/verification, claim lifecycle, team eligibility checks, rule CRUD,
   audit entries, and response redaction. Do not add this to the generic
   client-domain or email-sender-verification services: those prove a different
   authority.
2. Add documented owner-authorised endpoints, for example:

   - `GET /org/:orgId/email-domain-claims` — claims and non-secret rules;
   - `POST /org/:orgId/email-domain-claims` — begin/reissue claim and return
     the one-time TXT challenge;
   - `POST /org/:orgId/email-domain-claims/:claimId/verify` — validate DNS;
   - `DELETE /org/:orgId/email-domain-claims/:claimId` — revoke future use;
   - `POST`/`DELETE /org/:orgId/email-domain-claims/:claimId/rules` — add or
     remove a target team.

   Final request/response schemas, status codes, idempotency keys, and
   capability enforcement belong in the generated/public API contract. Update
   `API/src/routes/root/index.ts`, `API/src/routes/root/llm.ts`, and their
   `/api` documentation together with the routes.
   The Auth management-continuation routes are thin, login-token-gated wrappers
   over this same service; they re-resolve live owner authority and never make
   the browser call `/org/*` with a product or general user bearer.
3. Create one internal `applyVerifiedDomainAutoEnrolment` seam. It accepts only
   trusted values produced after authentication: user id, normalised verified
   email, verified identity method, and current UOA client domain. It is not an
   HTTP endpoint and never accepts a caller-supplied organisation/team id.
4. Refactor the account-creating paths so the seam runs **inside the same
   database transaction** as the new `User`, verified identity, domain role,
   invite acceptance, and consumed verification token. The relevant paths are
   password registration (`VERIFY_EMAIL_SET_PASSWORD`), passwordless email
   verification where it creates a user, and a newly-created user in every
   supported social callback. `LOGIN_CODE` only authenticates an existing user
   and is not an enrolment path. Remove the current post-commit, log-and-ignore
   calls in `auth-verify-email.service.ts` and `social-login.service.ts`: a
   failed admission must roll back the whole registration so its credential can
   safely be retried, never leave a consumed token and an incomplete account.
5. Query only verified claims in the current client domain and rules whose
   authentication-method requirement accepts the verified identity. In one
   transaction, lock relevant rows, create missing active org/team member rows,
   assign allowed default custom roles, and write one audit row per applied
   target. Treat an already-active row as idempotent; refuse to reactivate or
   alter `REMOVED`/`DEACTIVATED` rows, existing elevated roles, or custom roles.
   The complete set of matching teams for the one organisation succeeds or
   fails together.
6. Preserve normal registration eligibility, bans, MFA, invitation acceptance,
   and personal-organisation fallback semantics with explicit precedence:

   - An invite-bound verification token is an explicit workspace selection. If
     it names the same organisation as the verified-domain claim, atomically
     union the invite team with the claim's rule teams. If it names a different
     organisation in the same UOA client domain, accept the invite and do not
     apply the corporate claim; write a conflict audit event. Applying both
     would violate the one-active-organisation invariant.
   - A pending but unaccepted invite never suppresses a matching verified-domain
     claim. It remains pending. A later acceptance targeting a different
     organisation fails generically with no mutation, leaving the invitation
     actionable for an administrator to revoke/replace or for the person to be
     manually moved; UOA must never deactivate an existing membership to make
     it fit.
   - A successful corporate claim suppresses personal-organisation fallback.
     With no persistent-rule match, retain the exact existing legacy mapping and
     `pending_invites_block_auto_create` behaviour.

   DNS was completed when the owner verified the policy, not during a person's
   registration. Any membership/capacity failure rolls back this transaction;
   UOA never issues a successful first context that silently lacks promised
   access.
7. Enforce account/team capacity and billing-seat limits through the same shared
   membership admission function used by invite acceptance. If the transaction
   cannot admit every target team, make no membership changes and give the
   signer/operator an actionable failure. Add the shared seam first if it does
   not exist; do not duplicate membership capacity logic.

## Authenticator interface and reachability

1. Keep the platform-superuser Admin app out of this workflow. Add a dedicated
   Auth **Organisation access rules** state reachable from the hosted workspace
   chooser only after its payload is extended with each organisation's live
   membership role. For every organisation where that role is `owner`, show a
   secondary **Manage automatic access** action; it opens the rules state
   without selecting a team or issuing an OAuth code. This is a deliberate new
   chooser-data/doorway contract, not an assumption that the current
   `WorkspaceChooserPage` already knows an owner's role.
2. Back the state with a short-lived, one-purpose Auth management continuation
   minted from the existing verified `login_token`. The Auth routes resolve the
   live user and owner membership on every mutation, scope the continuation to
   one organisation and client domain, and discard it on exit/expiry. It is not
   an `X-UOA-Access-Token`, product backend credential, reusable management
   bearer, URL parameter, local-storage value, or returned OAuth code.
3. The dedicated Auth page lists claimed domains, verification status and
   expiry, target teams, and an audit/history summary. It provides clear
   actions to add a domain,
   copy the one-time TXT value, reissue it, verify it, choose further eligible
   teams, and revoke the policy. It explains that enrolment affects only newly
   registered verified identities and gives direct links to normal member
   management for existing people.
4. Build the page and its dedicated Auth routes from the route contract, with
   loading, empty, pending, expired, DNS-not-yet-visible, verified, and revoked
   states. Do not display a matching-domain hint on unauthenticated registration
   pages. Add focused
   component/state tests and browser verification of the owner and non-owner
   chooser paths.

## Legacy mapping retirement and rollout

1. Ship the persistent claim/rule service, Auth UI, migration, and tests behind
   a server feature flag. It has priority over the legacy mapping only when a
   verified persistent claim matches the new account. Idempotent admission
   prevents accidental duplicate membership during the overlap.
2. The persistent system has **no** pre-auth lookup endpoint. In particular, it
   must not extend `GET /auth/domain-mapping` or return durable claim/rule data
   from it. That existing unauthenticated mapping lookup is a legacy discovery
   surface for signed configuration only; mark it deprecated at launch, warn
   its callers, and remove it with the mapping. The new Auth UI never calls it.
3. Retain `registration_domain_mapping` as a documented legacy configuration
   for a published deprecation window. UOA cannot safely auto-migrate every
   signed client configuration into a customer-owned DNS claim: it neither owns
   the customer's DNS nor necessarily has an inventory of every signed config.
   Provide configuration validation/warnings and an owner migration guide:
   verify the corporate domain in Auth, recreate each target-team rule, set
   eligible team policy, then remove the config mapping. The legacy path
   continues to bypass the new shared capacity/billing admission checks during
   the compatibility window; state that operational risk rather than claiming
   that the new checks retroactively protect it.
4. Measure only aggregate, non-identifying migration and failure metrics. Give
   operators a deterministic report of runtime legacy hits and persistent-rule
   matches. Do not log raw emails, TXT tokens, or unverified domain probes.
5. After all supported clients have removed the mapping and the deprecation
   window expires, remove `registration_domain_mapping` from the config schema,
   `auth-domain-mapping.service.ts`, `org-placement.service.ts`, config JWT
   redaction/docs, `/api` and `/llm` documentation, tests, and the Auth
   registration-domain design document. This is a separately announced breaking
   release, not an opportunistic cleanup in the feature launch.

## Verification and delivery order

1. Update the requirements, ReBAC research, Auth architecture/registration
   documentation, API docs, and product integration notes first to record the
   final ownership and new constraints.
2. Land schema/migration/RLS/audit support and test migration upgrade from the
   current baseline.
3. Implement claim and rule APIs with owner, cross-organisation, normalisation,
   DNS challenge, expiry/revoke, concurrency, and secret-redaction tests.
4. Implement the shared enrolment transaction and cover the actual
   account-creating verification paths: `VERIFY_EMAIL_SET_PASSWORD`,
   passwordless verify-email creation, and each supported social create path.
   Include multiple target teams,
   exact/IDN domain matching, method matching, idempotency/racing requests,
   bans, capacity, existing active membership, and no resurrection of removed
   or deactivated membership rows.
5. Implement the Auth page, role-bearing chooser contract, and management
   continuation. Test that owners can manage only their own organisation,
   admins/members cannot discover or mutate it, no URL leaks the access proof,
   and the UI accurately presents verification failure.
6. Run lint, typecheck, the affected API/Auth suites, migration checks, and
   headless browser verification. In a controlled staging domain, create a new
   email and a new social account and prove both enter two selected teams before
   the chooser and downstream Nessie SSO context are issued.
7. Enable for internal/test organisations, then opted-in corporate customers.
   Monitor enrolment audit events and admission failures before broad release;
   retain a feature-flag kill switch that stops new automatic grants without
   deleting audited claims or memberships already created.

## Non-goals

- No email-token invite is created or sent.
- No retroactive bulk enrolment, repeated-login repair, wildcard domain rule,
  SCIM replacement, or automatic elevated role assignment.
- No Nessie-local nickname, email, organisation, team, or membership store is
  introduced. The nickname-invitation work remains a separate UOA identity
  lookup feature.
