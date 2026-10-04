import { billingStatementV1ConformanceFixture } from './conformance-fixture.js';
import type { BillingStatementV2 } from './v2-types.js';

export const billingStatementV2ConformanceFixture: BillingStatementV2 = {
  ...billingStatementV1ConformanceFixture,
  schema_version: 2,
  statement_id: 'bst_conformance_v2',
  pinned_inputs: {
    ledger_snapshots: [
      {
        contract: 'metering-portfolio-v1',
        group_by: 'user',
        cursor: 'mup_1123456789ABCDEFGHIJKLMNOPQRSTUV',
        id: 'mup_1123456789ABCDEFGHIJKLMNOPQRSTUV',
        captured_at:
          billingStatementV1ConformanceFixture.pinned_inputs.ledger_snapshots[1]?.captured_at ??
          '2026-07-20T11:59:00.000Z',
        sha256:
          billingStatementV1ConformanceFixture.pinned_inputs.ledger_snapshots[1]?.sha256 ??
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    ],
  },
};
