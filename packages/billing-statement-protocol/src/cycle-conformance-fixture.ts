import type {
  BillingCycleDetailV2,
  BillingCycleDownloadRequestV2,
  BillingCyclesListV2,
} from './cycle-types.js';
import { BILLING_CYCLES_DOWNLOAD_PATH } from './cycle-types.js';

const subject = {
  product: 'deepwater', organisation_id: 'org_example',
  team_id: 'team_example', user_id: 'user_example',
};
const money = (amount: string, minor: string) => ({
  amount, amount_minor: minor, currency: 'USD', display: `US$${amount}`,
});
const summary = {
  cycle_id: 'cycle_example_2026_07',
  period: {
    month: '2026-07',
    starts_at: '2026-07-01T00:00:00.000Z',
    ends_at: '2026-08-01T00:00:00.000Z',
  },
  state: 'finalized' as const,
  scope: {
    organisation_id: 'org_example', team_id: 'team_example',
    cycle_scope: 'team' as const, payer_scope: 'team' as const,
  },
  product: { id: 'service_example', identifier: 'deepwater', name: 'DeepWater' },
  totals: [{
    currency: 'USD', subscription: money('20', '2000'),
    usage_charge: money('13', '1300'), credits_applied: money('-13', '-1300'),
    total_due: money('20', '2000'), total_paid: money('20', '2000'),
    outstanding: money('0', '0'),
  }],
  document_available: true,
};
const action = (documentId: string) => ({
  method: 'POST' as const,
  path: BILLING_CYCLES_DOWNLOAD_PATH,
  body: { ...subject, cycle_id: summary.cycle_id, document_id: documentId },
});

export const billingCyclesListV2ConformanceFixture: BillingCyclesListV2 = {
  schema_version: 2,
  generated_at: '2026-08-03T12:00:00.000Z',
  subject,
  cycles: [summary],
  next_cursor: null,
};
export const billingCycleDetailV2ConformanceFixture: BillingCycleDetailV2 = {
  ...summary,
  schema_version: 2,
  subscription_lines: [{
    id: 'subscription_example', label: 'Monthly subscription',
    charge_basis: 'per_seat', seat_policy: 'automatic', seat_timing: 'full_month',
    unit_price: money('10', '1000'), quantity: '2',
    active_seat_seconds: '5356800', month_seconds: '2678400',
    intervals: [{
      starts_at: '2026-07-01T00:00:00.000Z',
      ends_at: '2026-08-01T00:00:00.000Z', quantity: '2',
    }],
    customer_charge: money('20', '2000'),
  }],
  usage_lines: [{
    id: 'usage_example', label: 'Metered usage',
    customer_charge: { amount: '13', currency: 'USD', display: 'US$13' },
    credits_consumed: '13000',
  }],
  credits: {
    consumed: '13000', opening_balance: '25000', closing_balance: '12000',
    status: 'confirmed',
  },
  documents: [
    {
      document_id: 'document_monthly_example', kind: 'monthly_invoice', format: 'pdf',
      state: 'available', number: 'INV-2026-07-001', issued_at: '2026-08-03T12:00:00.000Z',
      customer_total: money('20', '2000'),
      download_action: action('document_monthly_example'),
    },
    {
      document_id: 'document_breakdown_example', kind: 'usage_breakdown', format: 'csv',
      state: 'available', number: null, issued_at: '2026-08-03T12:00:00.000Z',
      customer_total: null,
      download_action: action('document_breakdown_example'),
    },
  ],
  adjustments: [],
};
export const billingCycleDownloadRequestV2ConformanceFixture: BillingCycleDownloadRequestV2 =
  action('document_breakdown_example').body;
