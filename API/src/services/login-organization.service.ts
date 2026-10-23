import type { ClientConfig } from './config.service.js';
import { AppError } from '../utils/errors.js';

/** Keep the interactive continuation inside the organisation named by its signed config. */
export function assertLoginOrganization(config: ClientConfig, organizationId: string | undefined): void {
  const requested = config.login_flow?.organization_id;
  if (requested && requested !== organizationId) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }
}
