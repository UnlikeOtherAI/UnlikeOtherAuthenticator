# Placement lock correction — 691934e1

Maxis API TypeScript build passes. Serial owned PostgreSQL16 gate passes8tests:
the two-product placement race, GET/POST email placement and both rollback cases,
and four authorization-code/membership lifecycle races. Duration152.75seconds.
One worker, Node heap3072MiB; protected55440/55445databases untouched.

Retained-schema retry initially stops before database mutation because recovery
fixture uses findUniqueOrThrow with nonunique email. Corrected to findFirstOrThrow;
this failure does not invalidate the fresh race gate. Original failed schema
test_1792025161536_729754c053794de1b45822462b3e0861 remains unchanged for normal retry.
No aggregate acceptance or N03cutover. Logs preserve both outcomes, exit codes
and sanitized stdout. Slot released before fixture correction.
