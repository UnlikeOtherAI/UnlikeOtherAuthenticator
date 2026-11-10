# Machine enrollment verification

Run the protocol checks against a fresh owned source snapshot and disposable
PostgreSQL cluster. Record source tree, frozen-lock/toolchain hashes, commands,
exit codes and original failures outside the checkout. Production authority
requests, real enrollment/adoption and held-original changes are not test setup.

The focused suites exercise the authenticated supported HTTP interface and real
persistence:

| Suite | Contract boundary |
| --- | --- |
| `machine-human-consent.test.ts` | Strict public schema and authenticated capability discovery; intent/proof/GET/login grant nothing; explicit human/key consent, TOTP, exact request retry/scope, CSRF, immutable history and RLS. |
| `machine-agreement-consent.test.ts` | Original nonempty config-JWT state survives real signing persistence and receipt completion; separate explicit machine consent follows, with no product code, refresh token or synthetic human assurance. Profile separation stays enforced. |
| `machine-rotation-recovery.test.ts` | One concurrent successor, lost-reply/current-key recovery, journal-first replay policy, expiry and corruption, including terminal retirement after a prior nonterminal stop. |
| `machine-policy-fences.test.ts` | Ordinary family logout/refresh versus global epoch, scoped owner retirement, team loss/re-add, product and enterprise policy, exact legacy adoption and separate unavailable. |
| `machine-admin-revocation.test.ts` | Current first-party operator role/epoch, audited exact-device and all-device retirement across teams, without changing human epochs. |
| `machine-authority-races.test.ts` | Validation/revoke/rotation ordering, unchanged prepared deadlines, recovery after a commit behind its lock, security-reset precedence. |
| `machine-events-delivery.test.ts` | Duplicate/conflicting immutable events, restart, delayed commit prefix, cursor-expiry repair, authenticated readiness/push and lost acknowledgment. |
| `machine-wire-contract.test.ts` | Canonical int64/safe generations, separate unavailable, exact validated-byte context, published UTF-8 fixture, key-forgery refusal and private diagnostics. |

Build shared packages and API/Auth/Admin, then run workspace typecheck/lint.
Run machine suites with one worker and file parallelism disabled, apart from
other suites that can queue a global policy writer ahead of a deliberate race
barrier. CI uses a separate API-only step for this reason; barriers wait on the
exact subject's lock, not an unrelated blocked transaction. Preserve the
existing human evidence/assurance, family refresh/revoke, native OAuth, enterprise
OIDC/SAML, factor/agreement and product-policy regression checks. CI's PostgreSQL
16 gate remains distinct from a local Windows PostgreSQL runtime check.

UI verification uses the built real components, fictional data and local
headless browser contexts. Exercise the actual login/team doorway, consent,
decline/expiry, owner revocation/failure recovery and Admin Security actions.
Capture only visibly changed pages/states at matching desktop/phone viewports
on the actual base and final revisions; embed Before/After pairs in the one PR.
Do not add a browser/UI suite to CI. A fresh naive-user review follows real frames.

Fixture signatures establish producer/HTTP/persistence behavior. They do not
establish installed native protected custody, physical installation identity,
inference execution, cancellation of provider-accepted work or production
enrollment. Consumer output/consume fences and final real human acceptance stay
separate. Deployment verification checks the exact resolved image/source,
compiled public version/capability/schema and serving health without minting
production authority.
