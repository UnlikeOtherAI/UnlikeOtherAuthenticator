import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Logo } from './Logo.js';
import { ThemeProvider } from '../../theme/ThemeProvider.js';

const TEST_CONFIG = {
  ui_theme: {
    colors: {
      bg: '#f8fafc',
      surface: '#ffffff',
      text: '#0f172a',
      muted: '#475569',
      primary: '#2563eb',
      primary_text: '#ffffff',
      border: '#e2e8f0',
      danger: '#dc2626',
      danger_text: '#ffffff',
    },
    radii: { card: '16px', button: '6px', input: '12px' },
    density: 'comfortable',
    typography: { font_family: 'sans', base_text_size: 'md' },
    button: { style: 'solid' },
    card: { style: 'bordered' },
    logo: { url: 'https://client.example.com/logo.png', alt: 'Client logo' },
  },
};

function renderLogo(rounded?: boolean): string {
  const config = {
    ...TEST_CONFIG,
    ui_theme: {
      ...TEST_CONFIG.ui_theme,
      logo: { ...TEST_CONFIG.ui_theme.logo, ...(rounded === undefined ? {} : { rounded }) },
    },
  };

  return renderToString(
    <ThemeProvider config={config} configUrl="">
      <Logo />
    </ThemeProvider>,
  );
}

describe('Logo', () => {
  it('rounds image logos by default', () => {
    expect(renderLogo()).toContain('rounded-[var(--uoa-radius-button)]');
  });

  it('preserves square image logos when the client disables rounding', () => {
    expect(renderLogo(false)).not.toContain('rounded-[var(--uoa-radius-button)]');
  });
});
