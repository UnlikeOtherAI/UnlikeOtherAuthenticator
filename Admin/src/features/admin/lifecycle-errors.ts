import { ApiRequestError } from '../../services/api-client';

const messages: Record<string, string> = {
  LIFECYCLE_TEMPLATE_CHANGED: 'This reason template changed. Review the refreshed customer message and try again.',
  ENTITY_TERMINAL: 'Deletion has already started. Open the deletion progress record to continue.',
  LAST_ACTIVE_PLATFORM_ADMIN: 'Another active platform administrator is required before disabling or deleting this account.',
  OWNERSHIP_TRANSFER_REQUIRED: 'Transfer ownership of retained organisations before deleting this account.',
  DELETION_PREVIEW_CHANGED: 'Dependencies changed. Request a new deletion preview and review it before confirming.',
  DELETION_BLOCKED: 'Deletion is blocked. Request a new preview to see the current blockers.',
  DELETION_RETRY_MISMATCH: 'This request key belongs to a different deletion. Request a fresh preview.',
  DELETION_PRODUCTS_PENDING: 'A product has not acknowledged cleanup yet. Its status is shown below.',
  DELETION_ALREADY_RUNNING: 'Cleanup is already running. Progress will refresh automatically; retry after its lease expires if it stopped.',
  DELETION_CANDIDATE_DEPENDENCY_CHANGED: 'An account acquired another dependency. Cleanup is blocked for administrator review.',
  ENTITY_DELETION_WORKFLOW_REQUIRED: 'Use the deletion preview and confirmation workflow for this record.',
};

export function lifecycleErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError && error.code && messages[error.code]) return messages[error.code];
  return 'The action could not complete. Refresh the current state and try again.';
}
