// RFC 8707 resource-indicator validation for the public-client / MCP OAuth profile
// (brief §22.14). A client-supplied `resource` becomes the token `aud`, so a registered
// public client could otherwise mint a validly-signed token for an arbitrary resource
// server (confused deputy). We bind the requested resource to an explicit allowlist.
import { getMcpOAuthResources } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

/**
 * Validates a client-supplied `resource` (RFC 8707) against the configured allowlist.
 *
 * - No resource requested → returns `undefined` (token-exchange falls back to the issuer
 *   as the `aud`); the caller passes no resource into the authorization code.
 * - Resource requested → it MUST exactly match one of MCP_OAUTH_RESOURCES_SUPPORTED. If
 *   the allowlist is empty or does not contain it, throws INVALID_TARGET (RFC 8707
 *   invalid_target). Returns the validated resource on success.
 */
export function validateRequestedResource(requested: string | undefined): string | undefined {
  const value = requested?.trim();
  if (!value) return undefined;
  if (!getMcpOAuthResources().includes(value)) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TARGET');
  }
  return value;
}
