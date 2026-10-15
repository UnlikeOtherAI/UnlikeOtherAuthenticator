# Group admission correction preliminary gates — c6c1e366

Maxis one compiler/worker, heap3072MiB. API TypeScript build passes.
Focused source-only group unit suite13/13passes (twofiles), no DB/listener.
Fresh real PostgreSQL upgrade from pinneda8daff44's200migrations to207passes.
Legacy identity/avatar/membership preserved; clean org receives no fabricated
history/revisions; orphaned and REMOVED group grants are repaired with exactly
two ordered minimal membership events; DEACTIVATED metadata survives. Older raw
INSERTs cannot recreate repaired grants. Pronoun constraint and first clean-org
atomic profile event still pass. Exit0. Schemas retained.

1e25dd87 adds only unselected writer guard tests during this gate. Real uoa_app
writer/race/outage tests and original failed-schema forward repair remain pending.
No production migration or live gate/credential change occurred.
