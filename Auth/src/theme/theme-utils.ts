import { DEFAULT_THEME, THEME_CSS_VAR_NAMES } from './theme-defaults.js';
import type {
  BaseTextSize,
  ButtonStyle,
  CardStyle,
  Density,
  FontFamily,
  Theme,
  ThemeClassNames,
  ThemeVars,
} from './theme-types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

function sanitizeHexColor(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === 'transparent') return trimmed;
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) {
    return trimmed;
  }
  return '';
}

function sanitizeCssLength(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === '0') return trimmed;
  // Allow a small set of safe length units. Reject anything with parentheses, semicolons, etc.
  if (/^[0-9]+(?:\.[0-9]+)?(px|rem|em|%)$/.test(trimmed)) return trimmed;
  return '';
}

function sanitizeHttpUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString();
  } catch {
    return '';
  }
}

function parseDensity(value: unknown): Density | '' {
  if (value === 'compact' || value === 'comfortable' || value === 'spacious') return value;
  return '';
}

function parseFontFamily(value: unknown): FontFamily | '' {
  if (value === 'sans' || value === 'serif' || value === 'mono') return value;
  return '';
}

function parseBaseTextSize(value: unknown): BaseTextSize | '' {
  if (value === 'sm' || value === 'md' || value === 'lg') return value;
  return '';
}

function parseButtonStyle(value: unknown): ButtonStyle | '' {
  if (value === 'solid' || value === 'outline' || value === 'ghost') return value;
  return '';
}

function parseCardStyle(value: unknown): CardStyle | '' {
  if (value === 'plain' || value === 'bordered' || value === 'shadow') return value;
  return '';
}

function mergeVars(base: ThemeVars, override: ThemeVars): ThemeVars {
  const next: ThemeVars = { ...base };
  for (const name of THEME_CSS_VAR_NAMES) {
    const v = override[name];
    if (typeof v === 'string' && v.trim()) next[name] = v.trim();
  }
  return next;
}

function parseThemeVars(uiTheme: Record<string, unknown>): ThemeVars {
  const vars: ThemeVars = {};

  const colors = isRecord(uiTheme.colors) ? uiTheme.colors : null;
  if (colors) {
    const bg = sanitizeHexColor(readString(colors, 'bg'));
    const surface = sanitizeHexColor(readString(colors, 'surface'));
    const text = sanitizeHexColor(readString(colors, 'text'));
    const muted = sanitizeHexColor(readString(colors, 'muted'));
    const primary = sanitizeHexColor(readString(colors, 'primary'));
    const primaryText = sanitizeHexColor(readString(colors, 'primary_text'));
    const border = sanitizeHexColor(readString(colors, 'border'));
    const danger = sanitizeHexColor(readString(colors, 'danger'));
    const dangerText = sanitizeHexColor(readString(colors, 'danger_text'));

    if (bg) vars['--uoa-color-bg'] = bg;
    if (surface) vars['--uoa-color-surface'] = surface;
    if (text) vars['--uoa-color-text'] = text;
    if (muted) vars['--uoa-color-muted'] = muted;
    if (primary) vars['--uoa-color-primary'] = primary;
    if (primaryText) vars['--uoa-color-primary-text'] = primaryText;
    if (border) vars['--uoa-color-border'] = border;
    if (danger) vars['--uoa-color-danger'] = danger;
    if (dangerText) vars['--uoa-color-danger-text'] = dangerText;
  }

  const radii = isRecord(uiTheme.radii) ? uiTheme.radii : null;
  if (radii) {
    const card = sanitizeCssLength(readString(radii, 'card'));
    const button = sanitizeCssLength(readString(radii, 'button'));
    const input = sanitizeCssLength(readString(radii, 'input'));
    if (card) vars['--uoa-radius-card'] = card;
    if (button) vars['--uoa-radius-button'] = button;
    if (input) vars['--uoa-radius-input'] = input;
  }

  const explicit = isRecord(uiTheme.css_vars) ? uiTheme.css_vars : null;
  if (explicit) {
    for (const name of THEME_CSS_VAR_NAMES) {
      const raw = readString(explicit, name);
      const v =
        name.startsWith('--uoa-color-') ? sanitizeHexColor(raw) : sanitizeCssLength(raw);
      if (v) vars[name] = v;
    }
  }

  return vars;
}

export function buildThemeFromConfig(config: unknown): Theme {
  const base = DEFAULT_THEME;
  if (!isRecord(config)) return base;

  const uiThemeUnknown = config.ui_theme;
  const uiTheme = isRecord(uiThemeUnknown) ? uiThemeUnknown : {};

  const vars = mergeVars(base.vars, parseThemeVars(uiTheme));

  const density = parseDensity(uiTheme.density) || base.density;

  const typography = isRecord(uiTheme.typography) ? uiTheme.typography : null;
  const fontFamily =
    (typography ? parseFontFamily(typography.font_family) : '') ||
    base.typography.fontFamily;
  const baseTextSize =
    (typography ? parseBaseTextSize(typography.base_text_size) : '') ||
    base.typography.baseTextSize;

  const button = isRecord(uiTheme.button) ? uiTheme.button : null;
  const buttonStyle = (button ? parseButtonStyle(button.style) : '') || base.button.style;

  const card = isRecord(uiTheme.card) ? uiTheme.card : null;
  const cardStyle = (card ? parseCardStyle(card.style) : '') || base.card.style;

  const logoUrl =
    sanitizeHttpUrl(readString(uiTheme, 'logo_url')) ||
    sanitizeHttpUrl(readString(isRecord(uiTheme.logo) ? uiTheme.logo : {}, 'url')) ||
    '';
  const logoAlt =
    readString(isRecord(uiTheme.logo) ? uiTheme.logo : {}, 'alt').trim() || base.logo.alt;

  return {
    vars,
    density,
    typography: { fontFamily, baseTextSize },
    button: { style: buttonStyle },
    card: { style: cardStyle },
    logo: { url: logoUrl, alt: logoAlt },
  };
}

function densityPagePadding(density: Density): string {
  switch (density) {
    case 'compact':
      return 'px-5 py-10';
    case 'spacious':
      return 'px-8 py-16';
    case 'comfortable':
    default:
      return 'px-6 py-12';
  }
}

function typographyClasses(typography: Theme['typography']): {
  font: string;
  baseText: string;
  title: string;
} {
  const font =
    typography.fontFamily === 'serif'
      ? 'font-serif'
      : typography.fontFamily === 'mono'
        ? 'font-mono'
        : 'font-sans';
  const baseText =
    typography.baseTextSize === 'sm'
      ? 'text-sm'
      : typography.baseTextSize === 'lg'
        ? 'text-lg'
        : 'text-base';
  return { font, baseText, title: 'text-2xl font-semibold tracking-tight' };
}

function cardClasses(style: CardStyle): string {
  const base =
    'rounded-[var(--uoa-radius-card)] bg-[var(--uoa-color-surface)] text-[var(--uoa-color-text)]';
  if (style === 'plain') return `${base}`;
  if (style === 'shadow') return `${base} shadow-lg shadow-black/5`;
  return `${base} border border-[var(--uoa-color-border)] shadow-sm shadow-black/5`;
}

function buttonPrimaryClasses(style: ButtonStyle): string {
  const base =
    'inline-flex w-full items-center justify-center gap-2 rounded-[var(--uoa-radius-button)] px-4 py-2.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--uoa-color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--uoa-color-bg)] disabled:opacity-60';
  if (style === 'outline') {
    return `${base} border border-[var(--uoa-color-primary)] bg-transparent text-[var(--uoa-color-primary)] hover:bg-[var(--uoa-color-surface)]`;
  }
  if (style === 'ghost') {
    return `${base} bg-transparent text-[var(--uoa-color-primary)] hover:bg-[var(--uoa-color-surface)]`;
  }
  return `${base} bg-[var(--uoa-color-primary)] text-[var(--uoa-color-primary-text)] hover:opacity-90`;
}

function buttonSecondaryClasses(style: ButtonStyle): string {
  const base =
    'inline-flex w-full items-center justify-center gap-2 rounded-[var(--uoa-radius-button)] px-4 py-2.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--uoa-color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--uoa-color-bg)] disabled:opacity-60';
  // Secondary stays neutral regardless of primary style choice.
  void style;
  return `${base} border border-[var(--uoa-color-border)] bg-[var(--uoa-color-surface)] text-[var(--uoa-color-text)] hover:opacity-90`;
}

export function buildThemeClassNames(theme: Theme): ThemeClassNames {
  const t = typographyClasses(theme.typography);

  return {
    appShell: `min-h-dvh bg-[var(--uoa-color-bg)] text-[var(--uoa-color-text)] ${t.font} ${t.baseText}`,
    pageContainer: `mx-auto max-w-lg ${densityPagePadding(theme.density)}`,
    card: `p-7 ${cardClasses(theme.card.style)}`,
    logoWrap: 'mb-6 flex items-center justify-center',
    title: t.title,
    buttonPrimary: buttonPrimaryClasses(theme.button.style),
    buttonSecondary: buttonSecondaryClasses(theme.button.style),
  };
}

export function themeVarsToCss(vars: ThemeVars): string {
  // Values are sanitized; emit in a stable order.
  const parts: string[] = [];
  for (const name of THEME_CSS_VAR_NAMES) {
    const v = vars[name];
    if (typeof v === 'string' && v) parts.push(`${name}:${v}`);
  }
  return parts.join(';');
}
