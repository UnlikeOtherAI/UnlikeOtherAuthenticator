import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PopupProvider } from '../hooks/use-popup.js';
import { I18nProvider } from '../i18n/I18nProvider.js';
import { ThemeProvider } from '../theme/ThemeProvider.js';
import { SigningPage } from './SigningPage.js';

const CONFIG = {
  language_config: 'en',
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
    radii: { card: '16px', button: '12px', input: '12px' },
    density: 'comfortable',
    typography: { font_family: 'sans', base_text_size: 'md' },
    button: { style: 'solid' },
    card: { style: 'bordered' },
    logo: { url: '', alt: 'Logo' },
  },
};

describe('SigningPage SSR shell', () => {
  it('renders the localized loading shell without exposing the capability', () => {
    const html = renderToString(
      <ThemeProvider config={CONFIG} configUrl="https://client.example/auth-config">
        <I18nProvider config={CONFIG} configUrl="https://client.example/auth-config">
          <PopupProvider
            config={CONFIG}
            configUrl="https://client.example/auth-config"
            initialSearch="?flow=signatures&signing_token=do-not-render-this-capability"
          >
            <SigningPage />
          </PopupProvider>
        </I18nProvider>
      </ThemeProvider>,
    );

    expect(html).toContain('Loading your agreements');
    expect(html).not.toContain('do-not-render-this-capability');
  });
});
