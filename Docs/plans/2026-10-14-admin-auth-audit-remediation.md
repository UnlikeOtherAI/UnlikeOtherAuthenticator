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
  logout cache regressions pass. Domain reveal and rendered journeys need final verification.
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
  regression proves one exchange and the preserved return destination. Auth callback concern maps to
  this concrete Admin component; inspected other Auth cancellation effects do not share that pattern.
- [ ] **U-33:** Confirmed same-route domain changes can retain scoped modal/form state. Domain tabs now
  remount for the exact domain. Overview/credentials use a domain-only key to preserve the existing
  identity draft between those tabs; credential reveals clear on section change. Rendered switching
  verification pending.
- [ ] **U-34:** Confirmed preview usability bug: noopener window.open returns null, which the old helper
  treated as blocked and immediately revoked. Preview now opens synchronously, detaches opener,
  fetches protected bytes through the shared client and navigates to a blob URL. Failure closes only
  its owned tab and leaves source download/retry available. Helper tests pass; actual browser lifecycle,
  failure, blocked-popup and mobile cases pending. Parent accepted the temporary blank loading tab.
- [ ] **U-36:** Exploit hypothesis not established. Configured language is model input, but no tools,
  identity authority, private data lookup or arbitrary output keys are available. Cache identity is
  exact language plus source hash. Known-key/string normalization remains unchanged; no capability
  is disabled. This disposition requires parent review rather than a speculative code change.

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
