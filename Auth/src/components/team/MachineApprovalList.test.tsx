import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MachineApprovalList } from './MachineApprovalList.js';
import { I18nProvider } from '../../i18n/I18nProvider.js';
import { ThemeProvider } from '../../theme/ThemeProvider.js';
import type { MachinePage } from '../../utils/machines.js';

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

it('keeps scoped bulk retirement reachable when recent ended history hides older approvals', () => {
  const page: MachinePage = {
    version: 1, csrf_token: 'fictional-csrf', client_domain: 'product.example.com',
    organization_name: 'Fictional Studio', team_name: 'Design', config_url: 'https://product.example.com/config',
    expires_at: '2026-11-10T22:00:00Z', truncated: true, request: null,
    enrollments: Array.from({ length: 100 }, (_, index) => ({ enrollment_id: `ended-${index}`,
      device_name: 'Fictional computer', decision: 'revoked', reason: 'device_revoked', created_at: '2026-11-10T20:00:00Z' })),
  };
  const html = renderToString(<ThemeProvider config={TEST_CONFIG} configUrl=""><I18nProvider config={{ language_config: 'en' }} configUrl="">
    <MachineApprovalList page={page} busy={false} hideEmpty={false} onRevoke={() => undefined} />
  </I18nProvider></ThemeProvider>);
  expect(html).toContain('Revoke all for this team');
  expect(html).not.toContain('>Revoke access</button>');
  expect(html).not.toContain('Current and stopped approvals');
});
