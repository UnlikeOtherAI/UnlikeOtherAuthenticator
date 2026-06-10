import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { getAppLogger } from '../utils/app-logger.js';
import { normalizeDomain } from '../utils/domain.js';
import type { ClientConfig } from './config.service.js';

/**
 * Union the admin-managed `ClientDomain.allowedRedirectUrls` into the verified config's
 * `redirect_urls`.
 *
 * A superuser can centrally permit additional redirect targets for a domain via the admin panel
 * without the partner re-signing their config JWT. The merged set is what `selectRedirectUrl`
 * enforces, so any redirect not in (config ∪ admin list) is still rejected.
 *
 * Fail-safe by design:
 * - Empty admin list → config is returned unchanged (backward compatible — current behaviour).
 * - DB disabled or lookup error → config is returned unchanged. Because this only ever *adds*
 *   URLs to the signed config's allowlist, a failed lookup can only make enforcement stricter,
 *   never wider, so swallowing the error here cannot weaken redirect security.
 */
export async function applyDomainRedirectAllowlist(config: ClientConfig): Promise<ClientConfig> {
  if (!getEnv().DATABASE_URL) return config;

  let extra: string[] = [];
  try {
    const registry = await getAdminPrisma().clientDomain.findUnique({
      where: { domain: normalizeDomain(config.domain) },
      select: { allowedRedirectUrls: true },
    });
    extra = (registry?.allowedRedirectUrls ?? []).map((url) => url.trim()).filter(Boolean);
  } catch (err) {
    getAppLogger().warn(
      { err, domain: config.domain },
      'failed to load admin redirect allowlist; falling back to config redirect_urls',
    );
    return config;
  }

  if (extra.length === 0) return config;

  const merged = [...new Set([...config.redirect_urls, ...extra])];
  if (merged.length === config.redirect_urls.length) return config;

  return { ...config, redirect_urls: merged };
}
