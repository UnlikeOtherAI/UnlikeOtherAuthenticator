import type { ProductEntitlementV1 } from './commercial-types.js';
export const productEntitlementMemberV1Fixture: ProductEntitlementV1 = {
  schema_version: 1, viewer: 'member', product: 'nessie', organisation_id: 'synthetic-company',
  subject: { team_id: 'synthetic-team', user_id: 'synthetic-person' },
  access: 'limited', full_access: false, history_window_days: 14, trial_ends_at: null,
  seats: { policy: 'free', capacity: null, admitted: true, can_admit_members: false },
  storage: { capacity_bytes: '100000000', used_bytes: '42000000',
    observed_at: '2026-10-13T00:00:00.000Z', can_upload: true, expansion_setup_required: true },
  observed_at: '2026-10-13T12:00:00.000Z', valid_until: '2026-10-13T12:01:00.000Z',
};
