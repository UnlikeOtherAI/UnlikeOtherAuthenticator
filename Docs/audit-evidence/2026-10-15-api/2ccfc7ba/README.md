# Admission/delegation gate — 2ccfc7ba

Six files,22tests pass in242.19seconds, exit0 on Maxis. Serial one-worker,
heap3072MiB, owned Fedora PostgreSQL55460. Runtime source inputs unchanged during
the gate; subsequent commits add unselected tests only.

- Real mapping creation waits behind a shared policy reader; deletion waits
  through actual RS256 signing and commit; disabling after preflight prevents
  issuance and leaves the assertion unconsumed. Resource signature verifies.
- Password reset3, explicit-confirmation 2FA reset2, optional canonical name4,
  action-bound verification7 (five failed guesses persist, one concurrent winner,
  current epoch and fresh enrolled MFA), social select-account3 all pass.

No aggregate/full113writer acceptance or N03cutover. All audit schemas retained.
Runner and compiler children completed before the next validation gate.
