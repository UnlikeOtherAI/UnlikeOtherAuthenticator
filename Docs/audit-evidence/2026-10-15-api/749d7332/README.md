# Three-org writer gate — 749d7332

Real PostgreSQL/TCP test fails: ownership-only org receives avatar upload,
avatar deletion and credential-epoch events but no self-profile PATCH event.
The membership-only and combined membership/ownership scopes are handled.
Profile PATCH independently discovered only OrgMember references; this is a real
scope-completeness defect, not a fixture error. One test fails, exit1; bail stops
the remaining selected files. No aggregate acceptance. Owned schema
test_1792025955294_9a49d6292a64443987c02cac72757318 is retained unchanged.
One Maxis worker, heap3072MiB, isolated Fedora PostgreSQL55460.
Slot released with runner finished before source correction.
