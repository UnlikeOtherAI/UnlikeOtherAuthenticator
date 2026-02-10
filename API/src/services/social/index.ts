import { AppError } from '../../utils/errors.js';
import type { ClientConfig } from '../config.service.js';
import type { SocialProviderKey } from './provider.base.js';

export function assertSocialProviderAllowed(params: {
  config: ClientConfig;
  provider: SocialProviderKey;
}): void {
  const allowed = params.config.allowed_social_providers ?? [];
  if (!allowed.includes(params.provider)) {
    // Brief 7.8: providers are enabled/disabled per-client via signed config.
    throw new AppError('BAD_REQUEST', 400, 'SOCIAL_PROVIDER_DISABLED');
  }
}

