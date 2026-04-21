import type { JWTPayload } from 'jose';

import type { ClientConfig } from './config.service.js';

export type ConfigValidationGuidance = {
  kind: 'required_next_step' | 'optional_customization' | 'operational_note';
  severity: 'info' | 'warning';
  code: string;
  summary: string;
  details: string[];
  field?: string;
};

const socialProviderKeys = ['google', 'facebook', 'github', 'linkedin', 'apple'] as const;
const supportedAuthMethods = new Set(['email_password', ...socialProviderKeys]);

export function buildConfigSummary(config: ClientConfig): Record<string, unknown> {
  return {
    domain: config.domain,
    redirect_url_count: config.redirect_urls.length,
    enabled_auth_methods: config.enabled_auth_methods,
    allowed_social_providers: config.allowed_social_providers ?? [],
    has_multiple_languages: Array.isArray(config.language_config),
    has_custom_font_import: Boolean(config.ui_theme.typography.font_import_url),
    uses_text_logo: Boolean(config.ui_theme.logo.text?.trim()),
    uses_logo_url: Boolean(config.ui_theme.logo.url.trim()),
    org_features_enabled: config.org_features.enabled,
    groups_enabled: config.org_features.groups_enabled,
    access_requests_enabled: config.access_requests.enabled,
    debug_enabled: config.debug_enabled,
  };
}

export function collectRuntimePolicyDetails(config: ClientConfig): string[] {
  const unknownMethods = config.enabled_auth_methods.filter(
    (method) => !supportedAuthMethods.has(method),
  );
  const enabledSocial = config.enabled_auth_methods.filter((method) =>
    socialProviderKeys.includes(method as (typeof socialProviderKeys)[number]),
  );
  const allowedSocial = config.allowed_social_providers ?? [];
  const blockedSocial = enabledSocial.filter((provider) => !allowedSocial.includes(provider));
  const allowedButDisabled = allowedSocial.filter(
    (provider) => !config.enabled_auth_methods.includes(provider),
  );
  const details: string[] = [];

  if (unknownMethods.length) {
    details.push(`Unsupported enabled_auth_methods: ${unknownMethods.join(', ')}`);
  }
  if (blockedSocial.length) {
    details.push(
      `Social providers missing from allowed_social_providers: ${blockedSocial.join(', ')}`,
    );
  }
  if (allowedButDisabled.length) {
    details.push(
      `allowed_social_providers not present in enabled_auth_methods: ${allowedButDisabled.join(', ')}`,
    );
  }

  return details;
}

export function buildConfigGuidance(
  config: ClientConfig,
  payload: JWTPayload,
): ConfigValidationGuidance[] {
  const guidance: ConfigValidationGuidance[] = [];

  if (config.allow_registration && !payloadHasPath(payload, ['allowed_registration_domains'])) {
    guidance.push({
      kind: 'required_next_step',
      severity: 'warning',
      code: 'REGISTRATION_DOMAIN_ALLOWLIST_RECOMMENDED',
      summary: 'Registration is enabled without allowed_registration_domains.',
      details: ['Add allowed_registration_domains unless every email domain should be able to register.'],
      field: 'allowed_registration_domains',
    });
  }

  if (!config.allow_registration) {
    guidance.push({
      kind: 'operational_note',
      severity: 'info',
      code: 'REGISTRATION_DISABLED_PREPROVISION_USERS',
      summary: 'Registration is disabled, so users must already exist before social login works.',
      details: ['If Google returns auth_failed, first check that the user exists for this domain.'],
      field: 'allow_registration',
    });
  }

  if (!config.ui_theme.logo.url.trim()) {
    guidance.push({
      kind: 'optional_customization',
      severity: 'info',
      code: 'LOGO_URL_OPTIONAL',
      summary: 'Add ui_theme.logo.url for a branded sign-in page.',
      details: ['The logo URL must be HTTPS and use the same host as config.domain.'],
      field: 'ui_theme.logo.url',
    });
  }

  if (!payloadHasPath(payload, ['ui_theme', 'typography', 'font_import_url'])) {
    guidance.push({
      kind: 'optional_customization',
      severity: 'info',
      code: 'FONT_IMPORT_OPTIONAL',
      summary: 'Add ui_theme.typography.font_import_url to use a hosted brand font.',
      details: ['Supported font hosts are fonts.googleapis.com, fonts.gstatic.com, and fonts.bunny.net.'],
      field: 'ui_theme.typography.font_import_url',
    });
  }

  if (!Array.isArray(config.language_config)) {
    guidance.push({
      kind: 'optional_customization',
      severity: 'info',
      code: 'LANGUAGE_SELECTOR_OPTIONAL',
      summary: 'Use a language_config array when the app should offer a language selector.',
      details: ['A single language_config string is valid for one-language installs.'],
      field: 'language_config',
    });
  }

  if (!payloadHasPath(payload, ['session', 'access_token_ttl_minutes'])) {
    guidance.push({
      kind: 'optional_customization',
      severity: 'info',
      code: 'ACCESS_TOKEN_TTL_OPTIONAL',
      summary: 'Set session.access_token_ttl_minutes to customize access-token lifetime.',
      details: ['Allowed range is 15 to 60 minutes. Omit it to use the service default.'],
      field: 'session.access_token_ttl_minutes',
    });
  }

  if (!payloadHasPath(payload, ['org_features'])) {
    guidance.push({
      kind: 'optional_customization',
      severity: 'info',
      code: 'ORG_FEATURES_OPTIONAL',
      summary: 'Add org_features when the app needs organisations, teams, or groups.',
      details: ['Leave it omitted for simple domain-level SSO.'],
      field: 'org_features',
    });
  }

  if (!payloadHasPath(payload, ['access_requests'])) {
    guidance.push({
      kind: 'optional_customization',
      severity: 'info',
      code: 'ACCESS_REQUESTS_OPTIONAL',
      summary: 'Add access_requests when users should request access instead of being invited manually.',
      details: ['When enabled, target_org_id and target_team_id are required.'],
      field: 'access_requests',
    });
  }

  return guidance;
}

function payloadHasPath(payload: JWTPayload, path: string[]): boolean {
  let current: unknown = payload;
  for (const part of path) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}
