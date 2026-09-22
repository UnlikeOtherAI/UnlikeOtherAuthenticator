import type { ClientConfig } from './config.service.js';

/**
 * The product's own name, from the client config's logo alt text, or null when the config gives
 * none. Sentences addressed to a person use this and say nothing rather than name a config host
 * ("…on api.nessie.works"). Never a value taken from the request: it comes from the verified JWT.
 */
export function resolveProductBrandName(config: ClientConfig): string | null {
  const alt = config.ui_theme?.logo?.alt?.trim();
  return alt && alt.length > 0 ? alt : null;
}

/**
 * A label that must always say something — the hosted auth window's browser tab and the
 * invitation pages' "Continue to …" control: the product's name, otherwise its config domain.
 */
export function resolveProductName(config: ClientConfig): string {
  return resolveProductBrandName(config) ?? config.domain;
}
