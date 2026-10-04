# Synthetic UOA billing producer fixtures

`nessie-funded-credit-cycle.json` is the public result of
`getBillingCycleDetail` after an actual PostgreSQL issuer and cycle test. It
contains an original 20% VAT invoice and two late funded usage supplements,
including two five-million-microcredit wallet debits whose customer-cent
offset is rounded cumulatively. The response passed UOA's strict public
cycle schema during hydration.

Regenerate it in an isolated disposable UOA database with
`BILLING_CONFORMANCE_PRODUCT=nessie` and
`BILLING_CONFORMANCE_OUTPUT=../proof/producer-fixtures/nessie-funded-credit-cycle.json`
when running `API/tests/integration/billing-cycle-manual-correction.persistence.test.ts`.
The provider receipt feed, actor signature verifier, and PDF byte storage are
test doubles. The invoice, wallet, allocation, issuance, and cycle records are
real PostgreSQL writes in the isolated test schema. IDs are synthetic and
not valid against a deployed UOA service.
