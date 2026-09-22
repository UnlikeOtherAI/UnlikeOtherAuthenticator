import type { ClientConfig } from './config.service.js';

/**
 * The name of the product a person is signing in to, for places UOA speaks for it: the browser tab
 * of the hosted auth window, the invitation pages' "Continue to …" control, the invitation copy.
 * The client config's own logo alt text when it has one, otherwise its domain. Never a value taken
 * from the request — both come from the verified config JWT.
 */
export function resolveProductName(config: ClientConfig): string {
  const alt = config.ui_theme?.logo?.alt?.trim();
  return alt && alt.length > 0 ? alt : config.domain;
}
