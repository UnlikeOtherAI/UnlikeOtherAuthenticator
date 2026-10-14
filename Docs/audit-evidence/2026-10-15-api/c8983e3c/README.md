# Authority upgrade and dependency gate — c8983e3c

Legacy upgrade passes on real PostgreSQL16: pinned baseline200 migrations plus
six current migrations, legacy identity/membership/avatar preserved, no invented
exact-org provenance or outbox/revision backfill, pronoun constraint enforced,
first atomic directory event revision1. Exit0.

Refusal gate: four cases pass (lifecycle, outside memberships/ownership,
native/platform identity, settings/session/history). Live financial responsibility
is correctly detected; its release fixture then violates the existing release
metadata constraint. This is a fixture failure, not a weakened production check.
Other tests in that runner did not run. Exit1. Schemas retained.
Slot released after completion for fixture correction.
