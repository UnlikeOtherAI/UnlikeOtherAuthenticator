# Admin/Auth audit remediation evidence

Owner branch: `fix/sol-audit-admin-20261014`. This scoped evidence supplements the
orchestrator-owned master checklist in Nessie; unchecked items require integration and final
verification. No production requests, credentials, migrations or deployments are part of this work.

- [ ] **U-12:** Confirmed repeated requests for non-bundled languages. Implemented successful-response
  settling, including partial responses with bundled fallback. I18nProvider regression passes.
- [ ] **U-13:** Confirmed drifting incomplete API dictionary. Implemented one dependency-free English
  source package imported by Auth/API; source hashing invalidates old cached translations. Docker
  build/runtime includes the package. Shared catalogue unit regression passes; builds pending.
- [ ] **U-14:** Confirmed bootstrap destroys stored credentials on network/server failure. Implemented
  status-preserving shared transport and bounded exponential bootstrap retry while protected content
  remains withheld. Maxis outage-recovery regression passes; browser verification pending.
- [ ] **U-15:** Confirmed stored expiry previously left React authenticated. Implemented expiry/focus
  synchronization and session-clear notification. Real-polling expiry regression passes.
- [ ] **U-16:** Confirmed arbitrary query-seeded handoff navigation. Implemented safe exact signed
  callback reconstruction with only OAuth response fields. Ordinary HTTPS OAuth completion and
  the public profile's registered HTTPS cancellation handoff remain available. Destination
  positive/negative unit cases pass; browser journey pending.
- [ ] **U-17:** Confirmed email initiation/resend/code verification/registration omit OAuth state.
  Implemented state forwarding at all four boundaries. Password login already forwards it and is
  preserved. Existing code-entry/team tests pass; browser request assertions pending.
- [ ] **U-18:** Confirmed plaintext in mutation results. Issuance/rotation mutations now return void,
  deliver only to mounted reveal owners, and have immediate inactive collection. Close/navigation
  clears reveals; confirmed logout clears QueryClient caches. Automation/product-key cache and
  logout cache regressions pass. Domain reveal/close and void mutation-result regression passes;
  rendered journeys need final verification.
- [ ] **U-19:** Confirmed app creation precedes icon validation/upload. Implemented prevalidation and
  committed-id recovery so upload retry updates the same app. It never deletes a created app.
  Hook regression passes; rendered create/fail/retry journey pending.
- [ ] **U-21:** Confirmed translation timeout ended before body read. Deadline now covers headers and
  JSON consumption, with aborted body reads failing before cache persistence. Stalled-body test passes.
- [ ] **U-31:** Confirmed configuration-dependent raw session transport bypasses same-origin guard.
  Bootstrap and token exchange now reuse the shared client. Actual provider cross-origin refusal
  regression passes without sending bearer credentials. No remotely controlled origin exploit claimed.
- [ ] **U-32:** Confirmed Admin callback's started-ref plus cancelled subscription suppresses completion
  under StrictMode replay. One exchange promise now receives a fresh active subscription. StrictMode
  regressions prove one exchange/session validation, the preserved return destination and reuse of
  an already validated session when revisiting the callback route. Auth callback concern maps to
  this concrete Admin component; inspected other Auth cancellation effects do not share that pattern.
- [ ] **U-33:** Confirmed same-route domain changes can retain scoped modal/form state. Domain tabs now
  remount for the exact domain. Overview/credentials use a domain-only key to preserve the existing
  identity draft between those tabs; credential reveals clear on section change. Component journeys
  prove email drafts and open signing-key editors do not cross same-route domain switches, including
  identical friendly labels. Headless browser switching verification remains pending.
- [ ] **U-34:** Confirmed preview usability bug: noopener window.open returns null, which the old helper
  treated as blocked and immediately revoked. Preview now opens synchronously, detaches opener,
  fetches protected bytes through the shared client and navigates to a blob URL. Failure closes only
  its owned tab and leaves source download/retry available. Helper tests pass; actual browser lifecycle,
  failure, blocked-popup and mobile cases pending. Parent accepted the temporary blank loading tab.
- [ ] **U-36:** Exploit hypothesis not established. Configured language is model input, but no tools,
  identity authority, private data lookup or arbitrary output keys are available. Cache identity is
  exact language plus source hash. Known-key/string normalization remains unchanged; no capability
  is disabled. A transport regression also proves unexpected output keys and non-string values are
  refused/fallback-normalized and no model tools are supplied. This disposition requires parent review
  rather than a speculative capability change.

## Human-flow review

Transient outages retain usable credentials and retry without granting protected content. Expired or
confirmed invalid authority returns to login. Failed logout retains its source for retry. Existing
HTTPS OAuth redirects and registered custom callbacks remain available. Credential reveal is still
shown once, with explicit close, and survives no navigation/sign-out. Native app save retains the
created record when icon upload fails, with an explicit recovery message and retry. Domain changes
cannot apply an old domain's form/modal state to a new record. Protected PDF preview remains an
operator capability; blocked or failed previews preserve the source download path.

## Validation at first checkpoint

Maxis, sequential focused tests: original 12 Admin plus 26 Auth passed; translation service 4 passed;
additional product-key, cross-origin and logout-cache tests 3 new cases passed. No skips. Scoped lint
found one forbidden non-null assertion, corrected before checkpoint. Typechecks, package/API/Auth/Admin
builds, Playwright desktop/mobile flows and screenshot review remain pending the allocated build slot.
No native inputs changed, so no native builds are required. No database is required for these injected
translation/frontend tests. Full integration checks remain the orchestrator's responsibility.

## Restart checkpoint

The replacement writer verified the exact worktree, branch and harmless create/read/delete probe
under Full Access on Maxis. Checkpoint e56afa78 and integration merge a02582e6 were pushed, followed
by a826e4da preserving registered HTTPS handoffs and existing authenticated callback navigation.
The integration merge retained both DNS recovery and translation architecture documentation.
The public OAuth cancellation caller uses the same handoff renderer even for HTTPS callbacks, so
validation accepts exact safe allowlisted HTTPS callbacks as well as custom schemes; arbitrary
HTTPS targets remain refused. No confidential/native authorization boundary changes.

Focused validation now covers 19 Admin recovery/cache/form cases, 15 additional existing Admin
compatibility cases, 56 Auth cases across selected files and 5 translation service cases. All passed
after correcting the existing NativeAppsPage test's partial mock to preserve the new error export.
Scoped ESLint and git whitespace checks pass. Playwright discovers 12 desktop/mobile journeys.
No new servers/databases or heavy compiler jobs started while awaiting the allocated slot.

## Allocated Maxis validation

The restart used the assigned worktree on Maxis, Full Access (`danger-full-access`), approval
policy `never`; a temporary file was created, read and deleted in that worktree. Git remained on
`fix/sol-audit-admin-20261014`. Before heavy work, Maxis had about 25 GiB free and negligible CPU
load; Fedora had about 7 GiB available with negligible load. All compilers ran sequentially in
the allocated slot with `NODE_OPTIONS=--max-old-space-size=5120`. No database, migration or remote
Minis build was used. API tests inject storage and do not connect to a database.

Passed on Maxis:

- Scoped Prisma client generation.
- Builds of `auth-ui-strings`, `slug`, and `billing-statement-protocol`, including its artifact check.
- API, Auth and Admin typechecks and builds (Auth client and SSR). Admin retains the nonfatal Vite
  large-chunk warning. A test-only unsupported `getByRole` option was removed before typechecking.
- All 12 discovered audit browser journeys, one worker, Chromium 145 headless: six desktop and six
  Pixel 7 mobile journeys. `pnpm --filter @uoa/admin exec playwright test
  --config=playwright.audit.config.ts` completed in 26.9 seconds with no retries or skips.

The browser run covers remote partial translation settling and email-code/resend OAuth state;
arbitrary handoff refusal, registered native handoff and registered HTTPS cancellation; bootstrap
outage recovery and expiry returning to a reachable login; native create/icon-failure/retry using
one saved app; one-time automation key close/navigation; and authenticated PDF blob bytes,
detached opener, failed-preview tab cleanup and blocked-popup recovery with a reachable source.
Desktop and mobile screenshots for each journey were visually inspected. Dialog save/close actions
remain reachable, synthetic credential text wraps, and recovery/handoff/code-error screens remain
legible. PDF source actions remain reachable by horizontal table scrolling on mobile.

Initial browser failures were fixture/environment defects: pinned Chromium was absent; an overly
broad i18n route intercepted Vite source modules; the outage fixture recovered during StrictMode's
second fetch before its assertion; and the old headless shell downloaded PDFs instead of rendering
them. The pinned browser was installed inside ignored worktree cache, routes now match API paths,
the outage fixture waits for the recovery assertion, and the config uses full Chromium new headless.
No product authorization or PDF lifecycle was weakened to satisfy the tests.

Evidence: [reviewed screenshot index](../audit-evidence/2026-10-14-admin-auth/README.md).
These browser results supersede the pending browser notes above for U-14, U-16, U-17, U-18,
U-19 and U-34. Shared-source builds resolve the U-13 build note. U-33 domain switching is verified
by component journeys, not a separate browser journey. No live provider or production endpoint was
exercised; browser API responses are synthetic fixtures. Native provider handshakes and deployments
remain integration responsibilities.

U-35 exact-bearer logout remains with the existing API owner and was not duplicated. U-28 is not
closed here: capability counterevidence must be considered by its owner. U-36 remains an
unestablished exploit hypothesis, with normalization regression evidence rather than a claimed
security closure. Nessie name/email are read-only; no email-save flow was added. Every checklist
item remains open pending parent acceptance. No PR or main merge is authorized in this branch.

Final serial regression run: Admin **49 files / 167 tests passed**, Auth **25 files / 162 tests
passed**, translation API **1 file / 5 tests passed**. No skips. Broad Admin validation initially
exposed stale billing fixtures: missing correction query/mutation exports and omitted now-required
tax attestation. The fixtures now supply the exact explicit tax inputs and mock the credit-note
lookup instead of attempting localhost API calls. No billing runtime code changed. Final Admin
typecheck, scoped ESLint and `git diff --check` passed after those fixture repairs.

The browser servers on 5291/5292 were verified stopped after validation. This writer explicitly
released its allocated heavy compiler slot; no heavy job or database remains owned by this work.

## U-18 deferred-response follow-up

Parent review established a remaining navigation race: DomainOverviewTab survives navigation
between Overview and Credentials to preserve the friendly-name draft, so clearing at navigation
alone did not stop a pending rotation from reopening its modal. BillingPage similarly retained a
captured product-key delivery callback across location changes. Rendered deferred-response tests
failed on both paths before the correction: the domain secret reappeared after Credentials →
Overview → Credentials, and billing secrets reappeared after a tab change, product change or
session-clear notification. These are additional U-18 evidence, not new issue IDs.

The common delivery guard now invalidates pending UI ownership at committed scope changes,
close/reopen, unmount and explicit session clearing. Domain delivery is scoped to the exact domain
in Credentials; billing issuance is location-keyed and additionally scoped to its product and open
dialog. The automation API-key hook has the same open/unmount/session guard. Captured callbacks
cannot deliver a delayed secret into a new scope. Mutations continue to return void with gcTime 0,
and still refresh non-secret metadata. No request cancellation, key deletion/revocation or plaintext
cache was introduced. An unchanged active dialog still receives its one-time reveal and can close
it normally. Operators who navigate away during issuance must inspect the metadata list before
retrying; the key may have been issued and cannot be revealed a second time.

Inspection also established late session restoration: completeSignIn awaited server validation,
then wrote a bearer even after clearStoredAdminSession had run. Its deferred-response test failed
before correction. Completion now verifies the same owner generation before persistence and rejects
superseded validation. Regressions prove session clearing/provider unmount prevents restoration,
while a fresh sign-in after clearing still works. No API logout implementation or U-35 owner file
was modified.

Maxis follow-up validation: **8 focused files / 31 tests passed**, one cached Vitest worker,
2 GiB heap. This includes the exact rendered DomainOverviewTab/BillingPage races, original active
reveal/close, product and automation hook callbacks after unmount/session clearing/close-reopen
under StrictMode, callback replay, cross-origin refusal, domain-switching and logout-cache checks.
An additional pending sign-in started during effect setup survives StrictMode replay for the same
owner; replay does not invalidate legitimate completion, while real unmount still blocks delivery.
Scoped ESLint and whitespace checks passed. There is no current compiler allocation for this
writer: no follow-up typecheck/build, browser server or browser rerun has started. Allocation was
requested through the monitored parent coordination output. Earlier build/browser results above
describe the preceding checkpoint and must not be represented as validation of these corrections.
Existing screenshots remain historical evidence; these lifecycle changes add no visible controls
or copy. Full browser rendering of the new deferred races remains pending an allocated slot.

Shared catalogue build-path source review: root `build` and `.github/workflows/ci.yml` use
`pnpm -r --if-present build`; both Auth/API declare the workspace dependency, and pnpm's dependency
inventory includes auth-ui-strings for both. Docker explicitly builds the catalogue before either
consumer and copies its dist into runtime; deploy-main builds that Dockerfile. The focused local
recipe in Docs/Testing/admin-debug-login.md omitted the catalogue prerequisite and now includes
it before Auth build/API tests. No CI, container or unchanged build scope was altered. This is source
and dependency-graph verification, not a new CI/container run.

All issue boxes remain open pending parent acceptance, including U-18. U-28/U-36 dispositions and
normal HTTPS OAuth/PDF behavior remain as recorded above.

## Allocated validation of 57455d4d (U-18 / U-37)

Validated application source **57455d4dab448999a8d7b8b44a9877515e7cc9be** in the same dedicated
branch/worktree on **Maxis**, Full Access and approval never. Parent reports integration as
22f9634a; this worktree validates its actual 57455d4d source, not an unverified integration revision.
Fresh local load was 24.5 GiB free / 2% CPU. One allocated heavy job at a time,
`NODE_OPTIONS=--max-old-space-size=5120`, with one browser/test worker. Nothing ran remotely on
Minis or against a database, production endpoint or live provider. API/logout/U1 work remains with
its existing owner. No application source changed during this validation; additions are local
browser fixtures, screenshot settling, download assertions and evidence.

- [ ] **U-37:** Late sign-in restoration after explicit clearing was established and corrected in
  57455d4d. Fresh browser assertions now prove rejection without storage restoration, legitimate
  fresh sign-in afterward, and same-owner StrictMode completion with exactly one validation call.
  Provider-unmount protection also passes in the focused rendered component suite. Parent acceptance
  is still required; this checkbox remains open.

Fresh serial commands and results:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=5120'
pnpm --filter @uoa/admin typecheck
pnpm --filter @uoa/admin build
pnpm --filter @unlikeotherai/auth-ui-strings build
pnpm --filter @uoa/auth typecheck
pnpm --filter @uoa/auth build
```

All five commands passed. Auth build includes client and SSR; catalogue output is freshly built
before Auth. Admin build retains its nonfatal >500 kB chunk warning. The application typechecks
cover src, while browser fixture code is transformed by Vite and checked with scoped ESLint. No
API/Prisma/native rebuild was needed for this frontend-only correction; those scopes were unchanged.

```powershell
pnpm --filter @uoa/admin exec vitest run src/pages/BillingPage.test.tsx src/features/admin/DomainOverviewTab.test.tsx src/features/auth/admin-session.test.tsx src/features/admin/credential-cache.test.tsx src/pages/AdminAuthCallbackPage.test.tsx src/pages/DomainDetailPage.test.tsx src/app/AppProviders.test.tsx src/features/auth/admin-session-origin.test.tsx --maxWorkers=1 --reporter=dot
$env:PLAYWRIGHT_BROWSERS_PATH=Join-Path (Get-Location) 'node_modules/.cache/ms-playwright'
pnpm --filter @uoa/admin exec playwright test --config=playwright.audit.config.ts
```

Focused rendered regression: **8 files, 31 passed, 0 failed, 0 skipped**, 18.47 seconds.
Final headless Chromium run: **26 passed, 0 failed, 0 skipped, 0 retries**, 40.2 seconds, 13 desktop
and 13 Pixel 7 mobile journeys. An initial 26/26 pass in 43.8 seconds preceded screenshot settling;
the final evidence comes from the fresh rerun after adding image decoding/font readiness. These
results replace the pending follow-up validation note above; older 12-case results are historical.
Scoped ESLint over the six audit flow/config/helper files and whitespace checks passed.

The final browser suite repeats the original 12 journeys and adds 14 lifecycle journeys. Real
pages exercise delayed domain rotation across Credentials → Overview history navigation, preserve
the friendly-name draft, reject stale reveal, permit active reveal/close, and navigate to another
selected domain without carrying a secret. Billing's delayed key cannot reopen after tab history
navigation; a subsequent active issuance still reveals and closes normally. Automation's delayed
key cannot reopen after explicit session clearing tears down the auth shell. The existing PDF
journey additionally completes a Source download with a .pdf filename and no download failure,
alongside preview bytes, null opener and failed/blocked preview recovery. Registered HTTPS OAuth
cancellation, email-state recovery and outage/expiry journeys all passed freshly.

Local-only lifecycle fixtures exercise the real product/automation hooks under StrictMode across
external close/reopen, unmount/remount and explicit session clearing, asserting no plaintext in
reveals, cache data or browser storage. They also exercise the real AdminSessionProvider for U-37.
These are mechanism tests with fixture controls, not additional production controls or claims that
a pending production dialog permits dismissal: pending dismissal remains blocked. The browser
session-clear cases validate the logout/expiry notification and teardown boundary; they do not
claim live server logout/revocation verification. Selected-product switching and provider-unmount
variants are additionally covered by the fresh component tests.

All **26 settled screenshots** were visually inspected and preserved in the
[57455d4d evidence index](../audit-evidence/2026-10-14-admin-auth/57455d4d/README.md). Active secrets
wrap legibly and close actions remain reachable on both viewports. Mobile PDF actions require
horizontal table scrolling, as before. Test-fixture screens are labelled distinctly. No new product
usability failure was established; the partially decoded logo was corrected in capture timing.
Browser suites remain local-only; no CI workflow was added or changed.

Both assigned servers returned HTTP 200 during the run. Playwright stopped its own servers after
each run. Final checks found no listeners on 5291/5292 and no compiler/Vite/esbuild/Chromium process
for this worktree. **UOA Admin explicitly RELEASED its allocated heavy slot after all children
finished.** All audit items remain open pending parent acceptance; no PR/main merge was performed.

## Dependent U-10 Members usability completion

- [ ] **U-10:** Frontend changes prepared against the parent-reviewed API contract in fd54d5fa.
  `formatAdminOrganisation` returns current account lifecycle in status and independent organisation
  membership in membershipStatus. The exact commit and Prisma enums were inspected read-only.
  The Admin service passes these DTO fields through, without coercion or a local identity store.
  The dedicated branch still has its preceding API baseline; fd54d5fa must be included by parent
  integration before treating the combined behavior as implemented server-side.

OrganisationMember now declares membershipStatus as active/deactivated/removed. The existing
OrganisationDetailPage Members table displays separate Account status and Membership columns,
alongside the existing role, teams and recent-login information. No member is filtered out or
labelled active based on the other state. An older payload missing membershipStatus displays
Unavailable. Synthetic mock factories now include the independent field, including add-to-team
fixture responses. No API-owned file was changed.

Account-disabled and membership-removed rows retain their canonical user/team navigation, owner
roles remain server-owned, and the existing read-only Members surface gained no mutation controls.
Lifecycle recovery stays on the user Security surface with existing server authorization. This
change neither reactivates a removed membership nor grants a disabled account access; no owner,
removal, deletion or disabled-account authorization rule was changed.

Focused component coverage includes active account + removed membership; disabled account + active
membership; active + deactivated; owner + active; deleted + removed; banned + deactivated; deleting
+ removed; missing membership state; and the empty table. Every populated case keeps its role,
team link and user-record navigation, with no new row action. Service regression checks list/detail
payloads retain both fields. Existing Directory navigation cases are included.

Maxis focused command: `pnpm --filter @uoa/admin exec vitest run
src/pages/OrganisationDetailPage.test.tsx src/pages/DirectoryPages.test.tsx
src/services/admin-service.test.ts --maxWorkers=1 --reporter=dot` — **3 files / 24 passed,
0 failed, 0 skipped**, 3.76 seconds. Scoped ESLint and `git diff --check` passed.

Prepared local browser scenario: audit-members.flow.ts, desktop and Pixel 7 through the existing
audit config. It asserts both status columns on owner/disabled/removed/deactivated rows, preserves
the user-record route and reaches the existing Reactivate access control without submitting any
write. Fixture account state, organisation list/detail and lifecycle response agree. It will capture
the settled Members table and disabled-account recovery surface. UI suites remain outside CI.

No heavy compiler slot is allocated to this writer at this stage. Only source review, scoped lint
and small cached serial tests ran on Maxis with a 2 GiB heap; no typecheck, build, browser server or
browser scenario has run for this U-10 change. Allocation is required for those next checks and
screenshot review. Prior 57455d4d evidence does not validate these new changes. All items remain
open for parent acceptance; no PR/main merge or other worktree write was performed.
