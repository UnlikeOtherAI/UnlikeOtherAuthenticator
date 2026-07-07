import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { WorkspaceChooserPage } from './WorkspaceChooserPage.js';
import { PopupProvider } from '../hooks/use-popup.js';
import type { WorkspaceChoices } from '../hooks/use-popup.js';
import { I18nProvider } from '../i18n/I18nProvider.js';
import { ThemeProvider } from '../theme/ThemeProvider.js';

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

function renderChooser(choices: WorkspaceChoices | null, pendingEmail: string | null = 'jo@example.com'): string {
  return renderToString(
    <ThemeProvider config={TEST_CONFIG} configUrl="">
      <I18nProvider config={TEST_CONFIG} configUrl="">
        <PopupProvider
          configUrl=""
          config={TEST_CONFIG}
          initialSearch="?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config"
          initialView="workspace-chooser"
          initialPendingEmail={pendingEmail}
          initialLoginToken={choices ? 'bridge.jwt' : null}
          initialWorkspaceChoices={choices}
        >
          <WorkspaceChooserPage />
        </PopupProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe('WorkspaceChooserPage SSR rendering', () => {
  it('renders nothing (bounces to login) without a login_token/chooser payload', () => {
    const html = renderChooser(null);
    expect(html).not.toContain('Choose a workspace');
  });

  it('renders the title and the email-scoped subtitle', () => {
    const html = renderChooser({
      teams: [
        { teamId: 't1', orgId: 'o1', name: 'Backend Team', role: 'member' },
        { teamId: 't2', orgId: 'o1', name: 'Frontend Team', role: 'owner' },
      ],
      pending_invites: [],
      can_create_org: false,
    });

    expect(html).toContain('Choose a workspace');
    expect(html).toContain('Your workspaces for jo@example.com');
  });

  it('renders each team name and the role only for owner/admin', () => {
    const html = renderChooser({
      teams: [
        { teamId: 't1', orgId: 'o1', name: 'Backend Team', role: 'member' },
        { teamId: 't2', orgId: 'o1', name: 'Frontend Team', role: 'owner' },
      ],
      pending_invites: [],
      can_create_org: false,
    });

    expect(html).toContain('Backend Team');
    expect(html).toContain('Frontend Team');
    expect(html).toContain('Owner');
    // "member" is not surfaced (design §11.2: role only shown for owner/admin).
    expect(html).not.toMatch(/>member</);
  });

  it('renders pending invite cards with accept/decline copy', () => {
    const html = renderChooser({
      teams: [
        { teamId: 't1', orgId: 'o1', name: 'Backend Team', role: 'member' },
        { teamId: 't2', orgId: 'o1', name: 'Frontend Team', role: 'owner' },
      ],
      pending_invites: [{ inviteId: 'inv-1', teamName: 'Growth Squad', invitedBy: 'Alex' }],
      can_create_org: false,
    });

    expect(html).toContain('You’ve been invited to');
    expect(html).toContain('Growth Squad');
    expect(html).toContain('Invited by Alex');
    expect(html).toContain('Accept');
    expect(html).toContain('Decline');
  });

  it('renders the create-workspace card only when can_create_org is true', () => {
    const withCreate = renderChooser({
      teams: [
        { teamId: 't1', orgId: 'o1', name: 'Backend Team', role: 'member' },
        { teamId: 't2', orgId: 'o1', name: 'Frontend Team', role: 'owner' },
      ],
      pending_invites: [],
      can_create_org: true,
    });
    expect(withCreate).toContain('Create a new workspace');

    const withoutCreate = renderChooser({
      teams: [
        { teamId: 't1', orgId: 'o1', name: 'Backend Team', role: 'member' },
        { teamId: 't2', orgId: 'o1', name: 'Frontend Team', role: 'owner' },
      ],
      pending_invites: [],
      can_create_org: false,
    });
    expect(withoutCreate).not.toContain('Create a new workspace');
  });

  it('shows only the create-workspace entry when there are no teams or invites', () => {
    const html = renderChooser({ teams: [], pending_invites: [], can_create_org: true });
    expect(html).toContain('Create a new workspace');
  });

  it('auto-skips a single team with no pending invites (never shows a one-item chooser)', () => {
    const html = renderChooser({
      teams: [{ teamId: 't1', orgId: 'o1', name: 'Solo Team', role: 'owner' }],
      pending_invites: [],
      can_create_org: false,
    });

    expect(html).not.toContain('Solo Team');
    expect(html).not.toContain('Choose a workspace');
    expect(html).toContain('Signing you in');
  });

  it('does not auto-skip a single team when there is also a pending invite', () => {
    const html = renderChooser({
      teams: [{ teamId: 't1', orgId: 'o1', name: 'Solo Team', role: 'owner' }],
      pending_invites: [{ inviteId: 'inv-1', teamName: 'Growth Squad', invitedBy: null }],
      can_create_org: false,
    });

    expect(html).toContain('Solo Team');
    expect(html).toContain('Choose a workspace');
  });
});
