import { adminConfigUrl, readAdminConfigJwt } from './admin-auth-config.service.js';
import { fetchConfigJwtFromUrl } from './config.service.js';

function normalizeExactUrl(value: string): string | null {
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

export function isFirstPartyAdminConfigUrl(configUrl: string): boolean {
  const normalizedConfigUrl = normalizeExactUrl(configUrl);
  const normalizedAdminConfigUrl = normalizeExactUrl(adminConfigUrl());
  if (!normalizedConfigUrl) return false;
  if (!normalizedAdminConfigUrl) return false;
  return normalizedConfigUrl === normalizedAdminConfigUrl;
}

export async function readConfigJwtFromTrustedSource(configUrl: string): Promise<string> {
  if (isFirstPartyAdminConfigUrl(configUrl)) {
    return readAdminConfigJwt();
  }

  return await fetchConfigJwtFromUrl(configUrl);
}
