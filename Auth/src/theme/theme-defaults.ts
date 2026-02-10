import type { Theme } from './theme-types.js';

export const THEME_CSS_VAR_NAMES = [
  '--uoa-color-bg',
  '--uoa-color-surface',
  '--uoa-color-text',
  '--uoa-color-muted',
  '--uoa-color-primary',
  '--uoa-color-primary-text',
  '--uoa-color-border',
  '--uoa-color-danger',
  '--uoa-color-danger-text',
  '--uoa-radius-card',
  '--uoa-radius-button',
  '--uoa-radius-input',
] as const;

// Defaults are a fallback for missing optional theme properties.
// They are not client-specific branding; they keep the UI usable.
export const DEFAULT_THEME: Theme = {
  vars: {
    '--uoa-color-bg': '#f8fafc', // slate-50
    '--uoa-color-surface': '#ffffff',
    '--uoa-color-text': '#0f172a', // slate-900
    '--uoa-color-muted': '#475569', // slate-600
    '--uoa-color-primary': '#2563eb', // blue-600
    '--uoa-color-primary-text': '#ffffff',
    '--uoa-color-border': '#e2e8f0', // slate-200
    '--uoa-color-danger': '#dc2626', // red-600
    '--uoa-color-danger-text': '#ffffff',
    '--uoa-radius-card': '16px',
    '--uoa-radius-button': '12px',
    '--uoa-radius-input': '12px',
  },
  density: 'comfortable',
  typography: {
    fontFamily: 'sans',
    baseTextSize: 'md',
  },
  button: {
    style: 'solid',
  },
  card: {
    style: 'bordered',
  },
  logo: {
    url: '',
    alt: 'Logo',
  },
};

