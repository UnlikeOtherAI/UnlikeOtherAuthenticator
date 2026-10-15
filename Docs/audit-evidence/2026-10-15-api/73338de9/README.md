# Original retained group grant forward repair — 73338de9

Owned PostgreSQL16 only. Original failed schema
`test_1792022987278_ecd28b77699643bcaf38219a0da3e472` upgraded normally from206to207.
One invalid grant repaired by the checked-in migration; its organisation membership
stays REMOVED. Original outbox records preserved; one minimal membership.changed
repair event added, linked to the former group grant id. A second normal migrate
deploy is idempotent with no new events. No row/lease/job manually edited or reset.
Test passes,3.31seconds, exit0. Schema/repair evidence retained.

Together with fresh200->207 upgrade and7real RLS/TCP writer cases, this closes the
observed post-removal group race and repairs the exact retained failure.
Full113-writer runtime coverage and remaining authority races remain open.
