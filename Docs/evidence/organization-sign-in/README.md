# Organization sign-in

The signed `login_flow.organization_id` narrows hosted sign-in to one organization. The chooser owns team selection, invitations, team creation and organization sign-in settings; Nessie supplies the stable organization ID from its public tenant resolver.

## Verification

- Windows Maxis: 50 focused API assertions across configuration, chooser, login-session binding, selection and creation routes. API and Auth type checks and scoped ESLint pass.
- Headless Edge on Maxis: `Auth/e2e/organization-sign-in-evidence.mjs`, 12 before/after desktop/phone scenarios. Actual API `buildSessionChoices` runs against a synthetic directory, then the real Auth UI renders its response. The base is `7412e754`; the implementation uses this branch. No real identities, invites or memberships are changed.
- The social link and resumed chooser retain the scoped config URL. Teams, invitations, creation destinations and organization settings are filtered together. No matching membership returns to sign-in. One matching member team continues automatically even with memberships elsewhere.
- The fixture OAuth destination is labelled as a fixture. Nessie's separate tenant-handoff suite verifies callback exchange and the final tenant channels page. Google authentication itself is not exercised by these local fixtures.
- The existing floating creation control extends 6 px beyond the 390 px viewport in both revisions. This change adds no horizontal overflow; the new no-access state fits 390 px.

## Screenshot order

Each state has desktop (1280 × 900) and phone (390 × 900) captures. Full-page height grows when needed.

1. Sign-in entry (unchanged context).
2. Teams, invitations and organization settings.
3. Team creation and its organization destination.
4. A person with memberships only outside the requested organization.
5. Return from the new no-access state to sign-in (no previous equivalent).
6. One matching team: the previous multi-organization chooser versus automatic continuation.
7. Fixture callback after continuation (no base equivalent because the base requires a choice).
