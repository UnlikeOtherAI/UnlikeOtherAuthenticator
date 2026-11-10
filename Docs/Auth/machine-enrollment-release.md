# Machine enrollment v1 release notes

Computer connections receive their own explicit UOA approval for one person,
product, protected key and team. Ordinary family-only browser sign-out leaves
that approval in place. Security resets, device revocation, scope removal and
enterprise policy can still stop it. The hosted Computer connections home and
Admin user Security panel provide revocation; English, Czech and Spanish owner
copy is included.
Renewal is labelled separately from a new connection. Approval records show their
creation time and reference, with current/stopped approvals separate from ended
history. Expired management pages offer fresh sign-in; failed checks keep current
access unknown. Admin all-device revocation names the person and its scope across
every product and team.

An additive migration preserves the original opaque state through required
config-JWT agreement signing, before separate machine consent. Released migration
history and original authorization events remain unchanged.

The new protocol provides immutable consent history, one rotating credential
lineage, response-loss recovery and authenticated revocation push/pull. New
admission and disclosure require current exact scope and expire within 30 seconds;
outages and reconciliation gaps hold work. Work already accepted follows its
existing receipt and stop/uncertainty rules.

This release creates no production enrollments and adopts no held human proofs.
Nessie/native installation continuity and final human acceptance remain separate.
See [the exact contract](machine-enrollment.md) and
[rollout requirements](../deployment.md#machine-enrollment-v1-rollout).
