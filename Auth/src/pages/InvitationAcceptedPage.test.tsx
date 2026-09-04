import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PopupProvider } from '../hooks/use-popup.js';
import { I18nProvider } from '../i18n/I18nProvider.js';
import { ThemeProvider } from '../theme/ThemeProvider.js';
import { InvitationAcceptedPage } from './InvitationAcceptedPage.js';

const CONFIG = {
  language_config: 'en',
  ui_theme: {
    colors: {
      bg: '#fff', surface: '#fff', text: '#111', muted: '#666', primary: '#111', primary_text: '#fff',
      border: '#ddd', danger: '#b00', danger_text: '#fff',
    },
    radii: { card: '12px', button: '8px', input: '8px' },
    density: 'comfortable',
    typography: { font_family: 'system-ui', base_text_size: 'md', font_import_url: '' },
    button: { style: 'solid' },
    card: { style: 'bordered' },
    logo: { url: '', alt: 'Logo' },
  },
};

describe('InvitationAcceptedPage SSR rendering', () => {
  it('confirms that the workspace invitation was accepted', () => {
    const html = renderToString(
      <ThemeProvider config={CONFIG} configUrl="https://client.example/auth-config">
        <I18nProvider config={CONFIG} configUrl="https://client.example/auth-config">
          <PopupProvider
            config={CONFIG}
            configUrl="https://client.example/auth-config"
            initialSearch="?flow=team_invitation_accepted"
          >
            <InvitationAcceptedPage />
          </PopupProvider>
        </I18nProvider>
      </ThemeProvider>,
    );

    expect(html).toContain('Invitation accepted');
    expect(html).toContain('You’ve joined the workspace');
  });
});
