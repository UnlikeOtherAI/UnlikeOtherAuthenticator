# Retired: `codex/sso-team-directory-invites`

**Status:** retired unmerged, 2026-09-02. Recoverable at tag
`retired/sso-team-directory-invites` (`589a724`).

Nine commits from 2026-08-14 in two phases. Neither should be merged. This
note exists so the question is not re-opened from scratch a third time — the
branch sat unmerged for nineteen days and two separate efforts have already
re-derived parts of it.

## Phase A2.1a — team-invite delivery — **superseded**

Main re-implemented this independently and has since moved past it.

- `API/src/services/team-invite-state-machine.ts` exists on **both** sides.
  Merging main produces an **add/add conflict** on it. Main's is 247 lines to
  the branch's 245, with the same `isTerminal` / `isResolved` / `isActionable`
  / `isExpired` / `decideTeamInviteTransition` surface, plus `deriveInviteStatus`
  and the `InviteLifecycleRow` / `TeamInviteStatusValue` naming that main's
  callers now depend on. The branch's older `InviteStateRow` shape would be a
  regression.
- Main carries `20260815090000_team_invite_revocation` and
  `20260816140000_team_invite_actionable_invariants`. The latter creates
  **byte-for-byte the same** `team_invites_one_actionable_per_team_email` index
  as the branch's `20260814130000_team_invite_delivery_foundation`, and neither
  uses `IF NOT EXISTS`. Main's has already run in production, so merging the
  branch adds an unapplied migration that recreates an existing index and
  **fails `prisma migrate deploy`** — on the identity provider, where the deploy
  workflow does not gate on CI.

Merging main into the branch produces 13 conflicts across the schema, six
`team-invite.service.*` modules, the published contract and the docs.

## Phase A1 — identity/membership delegation scopes — **no consumer**

Not superseded; nothing asks for it. It adds `identity.read`,
`membership.invite` and `membership.manage` to `ConfidentialDelegationScope`,
pins them to Nessie, and narrows the advisory `email` claim so those scopes
never carry it.

No product requests any of the three — Nessie's delegated-identity paths ask
only for `ai.invoke` and `billing.read`. The email narrowing is bound to the
same scopes, so it is equally inert.

The roster-authorization problem A1 targeted was solved on 2026-09-02 by
`X-UOA-Subject-Assertion` (`/llm` §4.6c, commit `42ece69`), with its Nessie
client half in Nessie `dd80e6ba`. A1 and the subject assertion are competing
designs from the same effort two weeks apart; the later one shipped and is
live. Landing A1 now would add a second, unused delegation path beside a
working one.

## If it is ever wanted

Cherry-pick `d0c5527 63be386 8785ce4 fed59f7 b8d2bf5` — the A1 commits, which
touch no team-invite files, so the split is clean. Expect one real conflict:
main split `llm-integration.ts` into `llm-integration-backend-mode.ts` +
`llm-integration-teams.ts` while the branch split the same file into
`llm-confidential-delegation.ts`. Both refactorings have to be reconciled by
hand. Renumber the migration to post-date main's latest; its
`ADD VALUE IF NOT EXISTS` statements are idempotent, so only the ordering
matters.

Do **not** cherry-pick the A2.1a commits (`d1f24db b53875d 49e18a2 589a724`)
without first reconciling them against main's own implementation.
