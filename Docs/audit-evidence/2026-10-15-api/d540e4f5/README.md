# Corrected canonical writer families — d540e4f5

Real PostgreSQL16/TCP, runtime uoa_app/uoa_admin. uoa_app is explicitly asserted
non-BYPASSRLS. All7cases pass,61.16seconds, exit0:
- Global profile/avatar upload/delete/credential-epoch changes invalidate both
  current orgs with exact contiguous revisions; stale JWT refused.
- All7group CRUD/member/team-assignment writers commit ordered events; assignment
  response preserves existing join policy and icon.
- Canonical row/revision/event rollback together under tenant RLS.
- The originally failing observed user-lock race now refuses400 after org removal,
  without recreating group grant or adding an unauthorized event.
- Cross-origin subject admission works without an identity copy; actual function
  permission outage remains generic500 and rolls back the attempted mutation.
- Missing/sibling tenant context cannot use the definer boolean guard.
- Deleting subject is refused by both current API and older raw INSERT(P2003).

8f1f4745 changes only four unselected race fixtures during this gate. Original
failed schema/row remains untouched pending normal forward-migration proof.
Listener/runner closed; schema retained. Full113-writer acceptance remains open.
