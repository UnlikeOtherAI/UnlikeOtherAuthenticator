# Computer connections review disposition

The first fresh Opus 5.5 review inspected 42 fictional desktop/phone frames on
runtime source tree `e12ec478a33937a555f27ff1eb908a5f4ac67b47`. Its original manifest
and review remain preserved outside the checkout. This disposition records the
bounded changes accepted after that review; replacement frames and checks must
be recorded against the corrected source before release.

| Finding | Disposition |
| --- | --- |
| B1: renewal versus new connection | Separate renewal title, first paragraph and action. New renewal requests verify the exact original binding, name and current key before review; terminal originals require a new grant. No physical identity, automatic consumer adoption or duplicate-computer promise. |
| B2: same-name records | Label the actual enrollment timestamp “Record created”, retain seconds/milliseconds, and show its canonical approval reference in rows and exact-revoke confirmations. Never label it the latest approval or revocation time. |
| B3: product identity | “Requested by {domain}” uses the verified client domain. No invented product display name. |
| S1: failures | Continuation, consent and revocation have actionable distinct messages. Revocation failure leaves current access unknown; controls remain retryable. Admin machine confirmations use their own truthful error text without changing unrelated dialogs. |
| S2: revoke confirmation | Shared plain caveat: the 30-second bound begins after confirmed revocation; already accepted work may finish or stop safely. Owner confirmation uses the existing danger colours. Scoped bulk confirmation is visibly separate. |
| S3: expired page | Preserve the original config URL and start a fresh ordinary human management sign-in. A direct page with no source context gives the requesting-product instruction, with no dead reload button. Sign-in alone never renews machine authority. |
| S4: feedback overlay | Admin actions sit below their row text at the left, with bottom clearance. New captures must show the panel and verify that the feedback control does not intercept the action. |
| S5: Admin scope and consistency | “Approved” matches the owner label. The exact confirmation names the person, team/product and record. All-device confirmation names that person and every product/team, while preserving other people's approvals and browser sessions. |
| S6: bulk placement | Separate labelled section for all of this person's selected-product/team approvals. A truncated inventory never advertises an exact complete count. |
| S7: team instruction | Explain that the shown team is this request's scope and approval happens next. Management keeps the team-choice instruction. |
| S8: current account | Show the already available sign-in address when present. No extra profile fetch/store, new identity authority or claim about why another account lacks access. |
| S9: results | Approval returns the person to the requesting domain without claiming online status. Decline changes only that request, with existing approvals explicitly unaffected. Expiry asks for a new request and makes no hardware/adoption claim. |
| S10: consent security | Explain scope, other permissions, duration and the events that can stop approval. Management/revocation becomes available after approval; no dangling promise of an action absent from first consent. |
| S11: empty state | Say there are no approvals for this person/team and direct connection setup through the requesting product. Do not claim no other person has a connected computer. |
| S12: outage | Current access could not be loaded, with retry. No promise that nothing changed, approvals remain active or consumer deadlines extend. |
| O1–O4 | Keep unambiguous dates and full precision; add the machine sign-in context; use the consent question as its page title; replace base/final Admin frames at a matching inner-scroll anchor and include all-device confirmation. |

Only `{device_revoked, all_devices_revoked, credential_replay, lineage_invalid}`
are terminal history. `security_reset` and other nonterminal stops keep lawful
explicit retirement available. The wire decision remains unchanged; a friendlier
UI status never grants access or revives a stopped authorization.

English, Czech and Spanish owner copy is maintained together. Admin retains its
existing English interface. Existing controls and layout are reused; no unrelated
screen, native application or consuming product is changed. Final manual checks
must cover fresh sign-in, retry controls, exact and bulk revoke, accurate labels,
visible Admin desktop/phone panels, and the agreement-to-consent boundary.
