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
    tariff: billingStatementV1ConformanceFixture.pinned_inputs.tariff,
  },
  connected_service_usage: {
    title: 'Connected-service usage',
    description:
      'Team-wide raw usage across connected services. Other services are shown for transparency and are not added to this statement total.',
    statement_product: 'deepwater',
    services: [
      {
        billing_product: 'deepwater',
        name: 'DeepWater',
        display_name: 'DeepWater',
        access: 'direct',
        direct_user_count: 2,
        title: 'DeepWater team usage',
        description:
          'DeepWater used 1,000 raw tokens across this team. DeepWater originated 56.00%; Nessie originated 44.00%.',
        totals: {
          calls: '10',
          usage: [
            {
              usage_unit: 'tokens',
              raw_units: '1000',
              display: '1,000 raw tokens across this team',
            },
          ],
          provider_costs: [
            {
              currency: 'USD',
              provider_cost: {
                amount: '10',
                currency: 'USD',
                display: '$10',
              },
              display: '$10 raw provider cost across this team',
            },
          ],
        },
        origins: [
          {
            product: 'deepwater',
            name: 'DeepWater',
            display_name: 'DeepWater',
            is_statement_product: true,
            calls: '6',
            call_share: {
              basis_points: 6000,
              percent: '60.00',
              display: '60.00% of DeepWater calls',
            },
            usage: [
              {
                usage_unit: 'tokens',
                raw_units: '560',
                share: {
                  basis_points: 5600,
                  percent: '56.00',
                  display: '56.00% of DeepWater tokens',
                },
                display: 'DeepWater originated 560 raw tokens (56.00%)',
              },
            ],
            provider_costs: [
              {
                currency: 'USD',
                provider_cost: {
                  amount: '5.6',
                  currency: 'USD',
                  display: '$5.6',
                },
                share: {
                  basis_points: 5600,
                  percent: '56.00',
                  display: '56.00% of DeepWater USD provider cost',
                },
                display: 'DeepWater originated $5.6 raw provider cost (56.00%)',
              },
            ],
          },
          {
            product: 'nessie',
            name: 'Nessie',
            display_name: 'Nessie',
            is_statement_product: false,
            calls: '4',
            call_share: {
              basis_points: 4000,
              percent: '40.00',
              display: '40.00% of DeepWater calls',
            },
            usage: [
              {
                usage_unit: 'tokens',
                raw_units: '440',
                share: {
                  basis_points: 4400,
                  percent: '44.00',
                  display: '44.00% of DeepWater tokens',
                },
                display: 'Nessie originated 440 raw tokens (44.00%)',
              },
            ],
            provider_costs: [
              {
                currency: 'USD',
                provider_cost: {
                  amount: '4.4',
                  currency: 'USD',
                  display: '$4.4',
                },
                share: {
                  basis_points: 4400,
                  percent: '44.00',
                  display: '44.00% of DeepWater USD provider cost',
                },
                display: 'Nessie originated $4.4 raw provider cost (44.00%)',
              },
            ],
          },
        ],
        users: [
          {
            user_id: 'user_example',
            name: 'Example User',
            email: 'example@example.invalid',
            display_name: 'Example User',
            calls: '6',
            call_share: {
              basis_points: 6000,
              percent: '60.00',
              display: '60.00% of DeepWater calls',
            },
            usage: [
              {
                usage_unit: 'tokens',
                raw_units: '600',
                share: {
                  basis_points: 6000,
                  percent: '60.00',
                  display: '60.00% of DeepWater tokens',
                },
                display: 'Example User used 600 raw tokens (60.00%)',
              },
            ],
            provider_costs: [
              {
                currency: 'USD',
                provider_cost: {
                  amount: '6',
                  currency: 'USD',
                  display: '$6',
                },
                share: {
                  basis_points: 6000,
                  percent: '60.00',
                  display: '60.00% of DeepWater USD provider cost',
                },
                display: 'Example User used $6 raw provider cost (60.00%)',
              },
            ],
          },
        ],
      },
    ],
  },
};
