# Authority races — a2ac1103

Real owned PostgreSQL16, Maxis serial runner, one worker, heap3072MiB.
All4files pass,21tests,219.60seconds, exit0:
refresh replay/convergence/corruption/theft/logout10;
authorization-code/membership lifecycle ordering4;
credential reset versus code/signing continuation4;
ClientDomain disable versus code/refresh3.
Both lock orders are exercised; refusals leave codes/tokens unconsumed, winning
issuance commits before subsequent scoped/epoch revocation. Fixtures use stable
authoritative ClientDomain IDs; domain bearer authentication was not weakened.
All schemas retained. No compiler/test child remains after completion.

This is focused race acceptance, not full113-writer or API aggregate acceptance.
