# Deletion source build and runtime gate 5 — f7253b04

API TypeScript build passes on Maxis. Serial PostgreSQL gate stops in the first
new refusal test: ACTIVE and committed-DELETING assertions pass, then the test's
DELETED fixture violates the existing users_identity_lifecycle check because it
still supplies identity fields. This is a fixture failure; the production check
is correct and remains enforced. Other cases and legacy upgrade did not run.
Owned audit schema retained. Exit1. No runtime acceptance claimed.
Compiler/test child completed; slot released for the fixture correction.
