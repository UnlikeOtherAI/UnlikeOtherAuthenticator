# Returning to the invited team

After accepting an invitation from email, Continue opens the product at the
invited team. The product may still ask the person to sign in and must check
current membership before opening that team.

A product opts in with signed config `login_flow.invitation_return_target: true`.
UOA first validates the requested continuation exactly against `redirect_urls`,
then appends `uoa_invite_org` and `uoa_invite_team` from the accepted invitation
to HTTP(S) destinations only. These references grant no authority and contain
no token, email or profile. Unlisted destinations remain unavailable. Ordinary
OAuth callbacks, native continuations and products that omit the flag retain
their current behavior.

The existing-account email confirmation, password registration confirmation and
social invitation confirmation all carry the same target. The password response
adds `accepted_invite: {orgId, teamId}` when `invite_accepted` is true. No OAuth
code is issued without PKCE, and acceptance does not bypass MFA on the subsequent
product sign-in.

Nessie owns the consuming entry on `/login`: it preserves the target through
sign-in, suppresses previous-team redirects, and uses its ordinary authorized
team switch and exact-target reauthorization. Failure stays on that entry with
retry, never in an unrelated remembered team. Deploy both products before
claiming the journey is fixed; old email links obtain the updated behavior when
their current signed configuration opts in.

Focused tests: API `team-invite-page.service`, `email-invite-continuation.service`
and `auth-email-invite-continue-link`; Auth `continue-url`, `InviteAcceptedPage`
and invitation registration; Nessie's local invitation-return browser journey.
