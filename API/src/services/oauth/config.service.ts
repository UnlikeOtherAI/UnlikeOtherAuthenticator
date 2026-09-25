// Synthetic first-party config for the public-client / MCP OAuth profile (brief
// §22.14). The /oauth/* flow has no client-supplied config_url; instead the auth
// service builds its own ClientConfig from env + the registered client's redirect
// URIs, then drives the SAME login / token machinery as the config-JWT flow.
import type { NativeApp } from '@prisma/client';
import { getAdminAuthDomain, getEnv, getPublicBaseUrl } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { type ClientConfig, validateConfigFields } from '../config.service.js';

// A neutral, valid default theme. The MCP login screen is first-party, so there is
// no per-client branding; this just satisfies the ui_theme contract for rendering.
const DEFAULT_UI_THEME = {
  colors: {
    bg: '#ffffff',
    surface: '#ffffff',
    text: '#111827',
    muted: '#6b7280',
    primary: '#2563eb',
    primary_text: '#ffffff',
    border: '#e5e7eb',
    danger: '#dc2626',
    danger_text: '#ffffff',
  },
  radii: { card: '12px', button: '8px', input: '8px' },
  density: 'comfortable',
  typography: { font_family: 'system-ui, -apple-system, sans-serif', base_text_size: 'md' },
  button: { style: 'solid' },
  card: { style: 'shadow' },
  logo: { url: '', alt: 'Sign in' },
};

/** Build the validated first-party ClientConfig for the MCP profile. `redirectUris`
 *  are the registered client's, so selectRedirectUrl validates against them. */
export function buildMcpClientConfig(redirectUris: string[], nativeApp?: NativeApp | null): ClientConfig {
  const env = getEnv();
  // The MCP profile must run on its own dedicated first-party domain — never the admin
  // domain (a SUPERUSER bootstrap there would bypass ADMIN_BOOTSTRAP_EMAILS) and never a
  // customer domain. Fail closed when misconfigured; public routes additionally require
  // the explicit MCP_OAUTH_PUBLIC_PROFILE_ENABLED gate.
  const configured = env.MCP_OAUTH_DOMAIN?.trim().toLowerCase();
  if (!configured) throw new AppError('INTERNAL', 500, 'MCP_OAUTH_DOMAIN_REQUIRED');
  if (configured === getAdminAuthDomain(env)) {
    throw new AppError('INTERNAL', 500, 'MCP_OAUTH_DOMAIN_FORBIDDEN_ADMIN');
  }
  const domain = configured;
  const methods = (env.MCP_OAUTH_ENABLED_AUTH_METHODS ?? 'email_password')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // validateConfigFields fills defaults for everything optional (session, org_features
  // disabled, access_requests disabled, user_scope=global, …) and validates the theme.
  const config = validateConfigFields({
    domain,
    redirect_urls: redirectUris,
    enabled_auth_methods: nativeApp?.methods ?? (methods.length > 0 ? methods : ['email_password']),
    language_config: 'en',
    ui_theme: nativeApp ? { ...DEFAULT_UI_THEME, colors: { ...DEFAULT_UI_THEME.colors,
      primary: nativeApp.primaryColor, bg: nativeApp.backgroundColor, text: nativeApp.textColor },
      logo: { url: '', alt: nativeApp.name } } : DEFAULT_UI_THEME,
    // Hosted password login completes enrolled TOTP or required enrollment.
    '2fa_enabled': true,
    allow_registration: nativeApp?.allowRegistration ?? false,
    session: { remember_me_enabled: false, remember_me_default: false },
  });
  // Trusted server-owned raster path only. Signed client config origin validation is unchanged.
  if (nativeApp?.iconType) config.ui_theme.logo.url = `${getPublicBaseUrl()}/oauth/apps/${encodeURIComponent(nativeApp.identifier)}/icon`;
  return config;
}
