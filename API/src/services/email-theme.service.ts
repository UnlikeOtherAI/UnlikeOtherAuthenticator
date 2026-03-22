import type { ClientConfig } from './config.service.js';
import type { EmailTheme } from './email.templates.js';

/** Extracts email-safe theme colors from the client config's ui_theme. */
export function extractEmailTheme(config: ClientConfig): Partial<EmailTheme> {
  const { ui_theme } = config;
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
    logoColor: ui_theme.logo.color || undefined,
  };
}
