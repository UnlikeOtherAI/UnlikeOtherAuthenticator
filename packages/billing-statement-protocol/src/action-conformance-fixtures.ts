import type { BillingConsumerActionConformanceFixturesV1 } from './action-types.js';

export const billingConsumerActionV1ConformanceFixtures = {
  hosted_redirect_response: {
    redirect_url: 'https://checkout.stripe.com/c/pay/cs_test_synthetic',
  },
  cancellation_preview: {
    schema_version: 1,
    preview_token: `uoa_cancel_${'t'.repeat(43)}`,
    expires_at: '2026-07-20T12:05:00.000Z',
    title: 'Cancel DeepWater?',
    message: 'Choose which direct subscriptions to cancel.',
    choice_required: true,
    choices: [
      {
        id: 'current_service',
        label: 'Cancel DeepWater only',
        description: 'Keep the team’s other direct product subscriptions active.',
        service_ids: ['service_deepwater'],
      },
      {
        id: 'current_and_related_direct_services',
        label: 'Cancel all related direct subscriptions',
        description: 'Also cancel Nessie.',
        service_ids: ['service_deepwater', 'service_nessie'],
      },
    ],
    direct_services: [
      {
        service_id: 'service_deepwater',
        product: 'deepwater',
        name: 'DeepWater',
        display_name: 'DeepWater',
        direct_user_count: 2,
        subscription_status: 'active',
      },
      {
        service_id: 'service_nessie',
        product: 'nessie',
        name: 'Nessie',
        display_name: 'Nessie',
        direct_user_count: 1,
        subscription_status: 'active',
      },
    ],
    indirect_services: [
      {
        product: 'deepsignal',
        name: 'DeepSignal',
        display_name: 'DeepSignal',
        impact: 'No separate subscription will be cancelled.',
      },
    ],
    confirm_action: {
      method: 'POST',
      path: '/billing/v1/cancellation/confirm',
      label: 'Confirm cancellation',
      idempotency_key: `uoa_confirm_${'i'.repeat(43)}`,
      selection_required: true,
      default_selection: null,
    },
  },
  cancellation_confirm_request: {
    preview_token: `uoa_cancel_${'t'.repeat(43)}`,
    idempotency_key: `uoa_confirm_${'i'.repeat(43)}`,
    selection: 'current_and_related_direct_services',
  },
  cancellation_confirmation: {
    schema_version: 1,
    status: 'confirmed',
    title: 'Cancellation scheduled',
    message: '2 direct subscriptions will end at their current period boundaries.',
    cancelled_services: [
      {
        service_id: 'service_deepwater',
        product: 'deepwater',
        name: 'DeepWater',
        display_name: 'DeepWater',
        status: 'cancels_at_period_end',
        effective_at: '2026-08-01T00:00:00.000Z',
      },
      {
        service_id: 'service_nessie',
        product: 'nessie',
        name: 'Nessie',
        display_name: 'Nessie',
        status: 'cancels_at_period_end',
        effective_at: '2026-08-01T00:00:00.000Z',
      },
    ],
    indirect_services: [
      {
        product: 'deepsignal',
        display_name: 'DeepSignal',
        impact: 'No separate subscription was cancelled.',
      },
    ],
  },
  error: {
    error: 'billing_request_failed',
  },
} satisfies BillingConsumerActionConformanceFixturesV1;
