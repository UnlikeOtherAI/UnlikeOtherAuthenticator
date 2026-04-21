import { decodeJwt } from 'jose';

import { getAdminAuthDomain, getEnv, requireEnv } from '../config/env.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { validateConfigFields, type ClientConfig } from './config.service.js';

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function publicBaseUrl(): string {
  const env = getEnv();
  return env.PUBLIC_BASE_URL ? normalizeBaseUrl(env.PUBLIC_BASE_URL) : `http://${env.HOST}:${env.PORT}`;
}

function adminAuthDomain(): string {
  return normalizeDomain(getAdminAuthDomain(getEnv()));
}

export function adminConfigUrl(): string {
  return `${publicBaseUrl()}/internal/admin/config`;
}

export function adminCallbackUrl(): string {
  return `${publicBaseUrl()}/admin/auth/callback`;
}

function assertExactlyGoogleOnly(config: ClientConfig): void {
  const enabledMethods = config.enabled_auth_methods;

  if (enabledMethods.length !== 1 || enabledMethods[0] !== 'google') {
    throw new AppError('INTERNAL', 500, 'ADMIN_CONFIG_MUST_BE_GOOGLE_ONLY');
  }
}

function assertAdminConfigPolicy(config: ClientConfig): void {
  if (normalizeDomain(config.domain) !== adminAuthDomain()) {
    throw new AppError('INTERNAL', 500, 'ADMIN_CONFIG_DOMAIN_MISMATCH');
  }

  if (!config.redirect_urls.includes(adminCallbackUrl())) {
    throw new AppError('INTERNAL', 500, 'ADMIN_CONFIG_CALLBACK_MISSING');
  }

  if (config.allow_registration !== false) {
    throw new AppError('INTERNAL', 500, 'ADMIN_CONFIG_REGISTRATION_MUST_BE_DISABLED');
  }

  assertExactlyGoogleOnly(config);
}

export function readAdminConfigJwt(): string {
  const { ADMIN_CONFIG_JWT } = requireEnv('ADMIN_CONFIG_JWT');
  const config = validateConfigFields(decodeJwt(ADMIN_CONFIG_JWT));
  assertAdminConfigPolicy(config);
  return ADMIN_CONFIG_JWT;
}
