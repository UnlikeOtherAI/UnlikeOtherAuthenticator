import type { ClientConfig } from './config.service.js';
import type { EmailTheme } from './email.templates.js';

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Extracts email-safe theme colors from the client config's ui_theme. */
export function extractEmailTheme(config: ClientConfig): Partial<EmailTheme> {
  const { ui_theme } = config;
  const logoStyle = ui_theme.logo.style as Record<string, string> | undefined;
  return {
    bg: ui_theme.colors.bg,
    surface: ui_theme.colors.surface,
    text: ui_theme.colors.text,
    muted: ui_theme.colors.muted,
    primary: ui_theme.colors.primary,
    primaryText: ui_theme.colors.primary_text,
    border: ui_theme.colors.border,
    buttonRadius: ui_theme.radii.button,
    cardRadius: ui_theme.radii.card,
    logoUrl: ui_theme.logo.url || undefined,
    logoAlt: ui_theme.logo.alt,
    logoText: ui_theme.logo.text || undefined,
    logoFontSize: ui_theme.logo.font_size || undefined,
    logoFontWeight: optionalString(ui_theme.logo.font_weight),
    logoFontFamily: logoStyle?.['font-family'] || undefined,
    logoColor: ui_theme.logo.color || undefined,
    fontImportUrl: ui_theme.typography.font_import_url || undefined,
  };
}
