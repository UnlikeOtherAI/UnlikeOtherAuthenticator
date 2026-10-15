# Org/team writer gate — 55486dbf

Full API typecheck passes. PostgreSQL/TCP/uoa_app gate passes4cases:
backend org/default-team provisioning and update; fresh/remove/re-add org
membership with both default-team branches and group cleanup; team creation,
role changes, removal, suspension/status-only restoration; fresh/removed self-join
role reset. Ordered minimal events and contiguous revisions are asserted.

The ownership case transfers canonical owner/roles successfully, then fails its
new expectation that existing directory grants automatically become unusable.
Current source and written handoff restrict grant mutations to the current
canonical owner, but do not explicitly invalidate org grants on transfer. This
expectation needs contract clarification; it is not yet classified as a source
authorization defect. One failure, four passes, exit1; remaining selected cases
did not run. Schema test_1792026408396_b814b6db216e4035883ffbc4f7e0d758 retained.
Runner ended; slot released before any dependent source correction.
