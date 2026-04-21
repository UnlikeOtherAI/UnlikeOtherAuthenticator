import type { FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { PUBLIC_ERROR_MESSAGE } from '../config/constants.js';
import { getEnv } from '../config/env.js';
import {
  createAuthDebugInfo,
  enrichAuthDebugForAppError,
  formatZodIssues,
} from '../services/auth-debug-page.service.js';
import { explainAuthProviderCode } from './error-auth-provider-explanations.js';
import { isAppError } from './errors.js';

export type PublicErrorBody = {
  error: string;
  code?: string;
  summary?: string;
  details?: string[];
  hints?: string[];
};

type PublicExplanation = {
  summary: string;
  details?: string[];
  hints?: string[];
};

const DEFAULT_HINTS = ['Check the request shape and server logs for more context.'];
const GENERIC_PUBLIC_ERROR_BODY: PublicErrorBody = { error: PUBLIC_ERROR_MESSAGE };

function defaultExplanation(code: string, statusCode: number): PublicExplanation {
  if (statusCode === 400) {
    return {
      summary: 'The request could not be processed because one or more inputs were invalid.',
      hints: ['Check required fields, field names, and allowed values.'],
    };
  }

  if (statusCode === 401) {
    return {
      summary: 'Authentication is required or the supplied credentials were not accepted.',
      hints: ['Check the supplied tokens, credentials, and auth preconditions for this route.'],
    };
  }

  if (statusCode === 403) {
    return {
      summary:
        'The request was understood, but the current identity does not have permission to perform it.',
      hints: ['Check the caller role, domain scope, and access token claims.'],
    };
  }

  if (statusCode === 404) {
    return {
      summary: 'The requested route or resource was not found.',
      hints: ['Check the URL path, identifiers, and whether the target exists.'],
    };
  }

  return {
    summary: 'The server hit an unexpected error while handling this request.',
    hints: ['Check the server logs for the full error and stack trace.'],
  };
}

function deriveCodeFromMessage(message: string): string | null {
  if (message === 'missing request.config' || message === 'missing request.configUrl') {
    return 'MISSING_CONFIG';
  }
  if (message.startsWith('Missing required environment variables:')) {
    return 'MISSING_ENVIRONMENT_CONFIGURATION';
  }
  if (message.startsWith('Unsupported EMAIL_PROVIDER:')) {
    return 'EMAIL_PROVIDER_UNSUPPORTED';
  }
  if (message.includes('required when EMAIL_PROVIDER=')) {
    return 'EMAIL_PROVIDER_CONFIGURATION_ERROR';
  }
  if (message === 'Invalid @sendgrid/mail module shape') {
    return 'SENDGRID_MODULE_INVALID';
  }

  return null;
}

function explainKnownCode(
  code: string,
  statusCode: number,
  error: unknown,
): PublicExplanation | null {
  switch (code) {
    case 'REQUEST_VALIDATION_FAILED':
      return {
        summary: 'The request did not match the expected body, query, or path parameter schema.',
        details: error instanceof ZodError ? formatZodIssues(error) : undefined,
        hints: ['Check required fields, field names, value types, and enum values.'],
      };
    case 'MISSING_CONFIG':
      return {
        summary:
          'This route requires a verified client config, but no config was attached to the request.',
        hints: [
          'Check that config_url is present and valid.',
          'Check that config verification middleware ran successfully before this handler.',
        ],
      };
    case 'MISSING_ENVIRONMENT_CONFIGURATION': {
      const message = error instanceof Error ? error.message : '';
      const suffix = message.split(':')[1]?.trim() ?? '';
      const missing = suffix
        ? suffix
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        : [];

      return {
        summary: 'The server is missing one or more required environment variables.',
        details: missing.length ? [`Missing variables: ${missing.join(', ')}.`] : undefined,
        hints: ['Set the missing environment variables and redeploy the service.'],
      };
    }
    case 'EMAIL_PROVIDER_CONFIGURATION_ERROR':
      return {
        summary: 'The configured email provider is missing required environment variables.',
        details: error instanceof Error ? [error.message] : undefined,
        hints: [
          'Set the missing email-provider environment variables for the selected EMAIL_PROVIDER.',
        ],
      };
    case 'EMAIL_PROVIDER_UNSUPPORTED':
      return {
        summary: 'EMAIL_PROVIDER is set to a value the server does not support.',
        details: error instanceof Error ? [error.message] : undefined,
        hints: ['Use a supported EMAIL_PROVIDER value and redeploy the service.'],
      };
    case 'SENDGRID_MODULE_INVALID':
      return {
        summary:
          'The SendGrid integration could not be initialized because the loaded module shape was invalid.',
        hints: ['Check the installed @sendgrid/mail package version and runtime bundling.'],
      };
    case 'CONFIG_URL_REJECTED':
      return {
        summary: 'The supplied config_url was rejected before any network request was made.',
        hints: ['Do not embed shared secrets or raw secret values in config_url.'],
      };
    case 'CONFIG_FETCH_FAILED':
      return {
        summary: 'The auth service could not fetch a usable config JWT from config_url.',
        hints: [
          'Check that config_url is reachable from the auth service.',
          'Check that the endpoint returns HTTP 200 and a JWT body or token field.',
        ],
      };
    case 'CONFIG_JWT_INVALID':
      return {
        summary: 'The fetched config JWT could not be verified for this auth service.',
        hints: ['Check the signing key, JWT algorithm, and kid.'],
      };
    case 'CONFIG_PAYLOAD_SECRET_REJECTED':
      return {
        summary: 'The config JWT payload contained a forbidden secret value.',
        hints: ['Remove any shared secret or other raw secret values from the config payload.'],
      };
    case 'CONFIG_SCHEMA_INVALID':
      return {
        summary: 'The config JWT passed fetch and signature checks but failed schema validation.',
        hints: [
          'Check required config fields such as domain, redirect_urls, enabled_auth_methods, ui_theme, and language_config.',
        ],
      };
    case 'CONFIG_DOMAIN_MISMATCH':
      return {
        summary: 'The config JWT domain does not match the hostname of config_url.',
        hints: ['Set config.domain to exactly match the config_url hostname.'],
      };
    case 'INVALID_TOKEN_REQUEST':
      return {
        summary: 'The token exchange request body is invalid.',
        hints: [
          'For authorization code exchange, send code.',
          'For refresh token exchange, send grant_type=refresh_token and refresh_token.',
        ],
      };
    case 'INVALID_REDIRECT_URL':
      return {
        summary: 'The supplied redirect_url is not a valid absolute HTTP(S) URL.',
        hints: ['Use a full http:// or https:// redirect URL.'],
      };
    case 'REDIRECT_URL_NOT_ALLOWED':
      return {
        summary: 'The supplied redirect_url is not allowlisted by the client config.',
        hints: [
          'Add the exact redirect URL to config.redirect_urls or send an already allowlisted URL.',
        ],
      };
    case 'MISSING_REDIRECT_URL':
      return {
        summary:
          'No usable redirect_url was provided and the client config did not provide a fallback.',
        hints: ['Send redirect_url or add at least one entry to config.redirect_urls.'],
      };
    case 'DATABASE_DISABLED':
      return {
        summary: 'This route requires the database, but DATABASE_URL is not configured.',
        hints: ['Set DATABASE_URL and ensure the database is reachable from the service runtime.'],
      };
    case 'AUTHENTICATION_FAILED':
      return {
        summary: 'Authentication failed.',
        hints: ['Check the supplied credentials, tokens, and required auth steps such as 2FA.'],
      };
    case 'INVALID_ACCESS_TOKEN':
      return {
        summary: 'The supplied access token is invalid, expired, or not accepted for this route.',
        hints: ['Obtain a fresh access token and retry the request.'],
      };
    case 'INVALID_AUTH_CODE':
      return {
        summary:
          'The supplied authorization code is invalid, expired, already used, or does not match this client request.',
        hints: ['Start a fresh login flow and exchange the new authorization code once.'],
      };
    case 'INVALID_REFRESH_TOKEN':
      return {
        summary:
          'The supplied refresh token is invalid, expired, revoked, or belongs to a different token family.',
        hints: ['Authenticate again to obtain a fresh refresh token.'],
      };
    case 'INVALID_TOKEN':
      return {
        summary: 'The supplied token is invalid for this request.',
        hints: ['Check that the token is current, unmodified, and belongs to this flow.'],
      };
    case 'INVALID_TOKEN_TYPE':
      return {
        summary: 'The supplied token exists but is not valid for this flow.',
        hints: ['Use the token with the route and flow it was issued for.'],
      };
    case 'INVALID_TOKEN_CONFIG_URL':
      return {
        summary: 'The supplied token does not belong to the provided config_url.',
        hints: ['Retry with the original config_url used when the token was issued.'],
      };
    case 'INVALID_TOKEN_USER':
      return {
        summary: 'The supplied token does not resolve to a valid user for this operation.',
        hints: ['Check that the token still belongs to an existing user record.'],
      };
    case 'TOKEN_ALREADY_USED':
      return {
        summary: 'The supplied token has already been used.',
        hints: ['Start the flow again to obtain a fresh one-time token.'],
      };
    case 'TOKEN_EXPIRED':
      return {
        summary: 'The supplied token has expired.',
        hints: ['Start the flow again to obtain a fresh token.'],
      };
    case 'MISSING_PASSWORD':
      return {
        summary: 'This operation requires a password, but none was provided.',
        hints: ['Provide the password field and ensure it satisfies the password policy.'],
      };
    case 'PASSWORD_POLICY_VIOLATION':
      return {
        summary: 'The supplied password does not satisfy the password policy.',
        hints: [
          'Use at least 8 characters including uppercase, lowercase, number, and special character.',
        ],
      };
    case 'USER_ALREADY_HAS_PASSWORD':
      return {
        summary:
          'This user already has a password set, so this password-setup flow cannot be used again.',
        hints: ['Use the standard login or password-reset flow instead.'],
      };
    case 'USER_NOT_FOUND':
      return {
        summary: 'The referenced user was not found.',
        hints: ['Check the user identifier and whether the record still exists.'],
      };
    case 'MISSING_ACCESS_TOKEN':
      return {
        summary: 'This route requires an access token, but none was provided.',
        hints: ['Send the expected access token header for this route.'],
      };
    case 'MISSING_DOMAIN':
      return {
        summary: 'This route requires a domain parameter, but none was provided.',
        hints: [
          'Provide the required domain parameter or ensure it is present in the verified config.',
        ],
      };
    case 'ACCESS_TOKEN_DOMAIN_MISMATCH':
      return {
        summary: 'The supplied access token does not match the requested domain.',
        hints: ['Use an access token issued for the same domain as the current request.'],
      };
    case 'INSUFFICIENT_ORG_ROLE':
      return {
        summary:
          'The current user does not have the organisation role required for this operation.',
        hints: ['Check the caller role and the minimum role required by this route.'],
      };
    case 'NOT_SUPERUSER':
      return {
        summary: 'This operation requires a superuser token.',
        hints: ['Use a token for a superuser on the target domain.'],
      };
  }

  return explainAuthProviderCode(code);
}

function deriveErrorCode(error: unknown, statusCode: number, fallbackCode?: string): string {
  if (fallbackCode) return fallbackCode;

  if (isAppError(error)) {
    return /^[A-Z0-9_]+$/.test(error.message) ? error.message : error.code;
  }

  if (error instanceof ZodError) {
    return 'REQUEST_VALIDATION_FAILED';
  }

  if (error instanceof Error) {
    return deriveCodeFromMessage(error.message) ?? (statusCode >= 500 ? 'INTERNAL' : 'BAD_REQUEST');
  }

  if (statusCode === 404) return 'NOT_FOUND';
  return statusCode >= 500 ? 'INTERNAL' : 'BAD_REQUEST';
}

function explanationFor(
  code: string,
  statusCode: number,
  error: unknown,
  fallbackSummary?: string,
  fallbackDetails?: string[],
  fallbackHints?: string[],
): PublicExplanation {
  return (
    (fallbackSummary
      ? {
          summary: fallbackSummary,
          details: fallbackDetails,
          hints: fallbackHints,
        }
      : null) ??
    explainKnownCode(code, statusCode, error) ??
    defaultExplanation(code, statusCode)
  );
}

function buildAuthDebugBody(
  request: FastifyRequest,
  error: unknown,
  _statusCode: number,
): PublicErrorBody | null {
  const requestUrl = request.raw.url ?? '';
  if (!requestUrl.startsWith('/auth')) return null;

  if (isAppError(error)) {
    enrichAuthDebugForAppError(
      request as FastifyRequest & { config?: { redirect_urls?: string[] } },
      error,
    );
  }

  const debug =
    request.authDebug ??
    (error instanceof ZodError
      ? createAuthDebugInfo({
          requestUrl,
          stage: 'request',
          code: 'AUTH_REQUEST_INVALID',
          summary: 'The auth request query could not be parsed.',
          details: formatZodIssues(error),
        })
      : null);

  if (!debug) return null;

  return {
    error: PUBLIC_ERROR_MESSAGE,
    code: debug.code,
    summary: debug.summary,
    details: debug.details.length ? debug.details : undefined,
    hints: debug.hints.length ? debug.hints : undefined,
  };
}

export function buildPublicErrorBody(params: {
  request?: FastifyRequest;
  error?: unknown;
  statusCode: number;
  code?: string;
  summary?: string;
  details?: string[];
  hints?: string[];
}): PublicErrorBody {
  if (!getEnv().DEBUG_ENABLED) {
    return GENERIC_PUBLIC_ERROR_BODY;
  }

  if (params.request && params.error) {
    const authDebugBody = buildAuthDebugBody(params.request, params.error, params.statusCode);
    if (authDebugBody) return authDebugBody;
  }

  const code = deriveErrorCode(params.error, params.statusCode, params.code);
  const customSummary =
    !params.summary &&
    isAppError(params.error) &&
    params.error.message &&
    !/^[A-Z0-9_]+$/.test(params.error.message)
      ? params.error.message
      : params.summary;
  const explanation = explanationFor(
    code,
    params.statusCode,
    params.error,
    customSummary,
    params.details,
    params.hints,
  );

  return {
    error: PUBLIC_ERROR_MESSAGE,
    code,
    summary: explanation.summary,
    details: explanation.details?.length ? explanation.details : undefined,
    hints: explanation.hints?.length ? explanation.hints : DEFAULT_HINTS,
  };
}
