import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CreateWorkspaceDialog } from './CreateWorkspaceDialog.js';
import { I18nProvider } from '../../i18n/I18nProvider.js';
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
    radii: { card: '16px', button: '12px', input: '12px' },
    density: 'comfortable',
    typography: { font_family: 'sans', base_text_size: 'md' },
    button: { style: 'solid' },
    card: { style: 'bordered' },
    logo: { url: '', alt: 'Logo' },
  },
  language_config: 'en',
};

function renderDialog(): string {
  return renderToString(
    <ThemeProvider config={TEST_CONFIG} configUrl="">
      <I18nProvider config={TEST_CONFIG} configUrl="">
        <CreateWorkspaceDialog
          loginToken="bridge.jwt"
          query={{ configUrl: 'https://client.example.com/auth-config' }}
          creatableOrgs={[
            { orgId: 'org-acme', orgName: 'Acme' },
            { orgId: 'org-globex', orgName: 'Globex' },
          ]}
          canCreateNewOrganisation
          onOutcome={() => undefined}
          onClose={() => undefined}
        />
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe('CreateWorkspaceDialog SSR rendering', () => {
  it('keeps a 12px mobile gutter and renders an opaque modal surface', () => {
    const html = renderDialog();

    expect(html).toContain('role="dialog"');
    expect(html).toContain('fixed inset-0 z-20 flex items-center justify-center bg-black/30 p-3');
    expect(html).toContain('max-h-[calc(100dvh-24px)] w-full max-w-md');
    expect(html).toContain('bg-[var(--uoa-color-surface)] p-5 shadow-xl');
  });

  it('offers the authorized organisation destinations and explicit visibility choices', () => {
    const html = renderDialog();

    expect(html).toContain('Create a new organisation');
    expect(html).toContain('>Acme</option>');
    expect(html).toContain('>Globex</option>');
    expect(html).toContain('>Private</option>');
    expect(html).toContain('>Invite only</option>');
    expect(html).toContain('>Open to organisation</option>');
  });
});
