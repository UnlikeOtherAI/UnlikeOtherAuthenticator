# Canonical writer gate — cb7e0697

Real PostgreSQL/TCP with production uoa_app/uoa_admin clients. Three cases pass:
all current orgs invalidated for profile/avatar create/delete/epoch; seven group
CRUD/member/team-assignment writers each commit ordered outbox events; group row,
revision and event rollback atomically under uoa_app tenant RLS.

Fourth case exposes a real defect: a group addition pre-reads current membership,
waits on the observed canonical user lock while org removal commits, then commits
without rechecking the removed membership. Expected400, actual committed.
Original failed schema/row/event retained.3pass1fail, exit1. No U1 acceptance.
Runner/listener completed; slot released for source and data repair correction.
