import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';

export function accessTokenExpiresInSeconds(ttl: string): number {
  const minutes = Number(ttl.replace(/m$/, ''));
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new AppError('INTERNAL', 500, 'INVALID_ACCESS_TOKEN_TTL');
  }
  return minutes * 60;
}

export function resolveAccessTokenTtl(config: ClientConfig, envTtl: string): string {
  const configMinutes = config.session?.access_token_ttl_minutes;
  return configMinutes == null ? envTtl : `${configMinutes}m`;
}

export function resolveRefreshTokenTtlSeconds(config: ClientConfig, rememberMe: boolean): number {
  const session = config.session;
  if (rememberMe) return (session?.long_refresh_token_ttl_days ?? 30) * 24 * 60 * 60;
  return (session?.short_refresh_token_ttl_hours ?? 1) * 60 * 60;
}
