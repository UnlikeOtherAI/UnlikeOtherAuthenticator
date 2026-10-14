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
