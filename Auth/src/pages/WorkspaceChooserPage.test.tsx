import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { WorkspaceChooserPage } from './WorkspaceChooserPage.js';
import { AuthLayout } from '../components/layout/AuthLayout.js';
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

/** `creatable_orgs` defaults to empty so the existing cases keep reading as the payloads they are. */
type ChooserFixture = Omit<WorkspaceChoices, 'creatable_orgs'> &
  Partial<Pick<WorkspaceChoices, 'creatable_orgs'>>;

function renderChooser(
  fixture: ChooserFixture | null,
  pendingEmail: string | null = 'jo@example.com',
  teamHint?: string,
): string {
  const choices: WorkspaceChoices | null = fixture ? { creatable_orgs: [], ...fixture } : null;
  const search = teamHint
    ? `?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config&team_hint=${encodeURIComponent(teamHint)}`
    : '?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config';
  return renderToString(
    <ThemeProvider config={TEST_CONFIG} configUrl="">
      <I18nProvider config={TEST_CONFIG} configUrl="">
        <PopupProvider
          configUrl=""
          config={TEST_CONFIG}
          initialSearch={search}
          initialView="workspace-chooser"
          initialPendingEmail={pendingEmail}
          initialLoginToken={choices ? 'bridge.jwt' : null}
          initialWorkspaceChoices={choices}
        >
          <AuthLayout>
            <WorkspaceChooserPage />
          </AuthLayout>
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

  it('renders an inline first-workspace form when there is no workspace destination yet', () => {
    const withCreate = renderChooser({
      teams: [],
      pending_invites: [],
      can_create_org: true,
    });
    expect(withCreate).toContain('Workspace name');
    expect(withCreate).toContain('This creates an organisation and its first workspace.');
    expect(withCreate).toContain('Visibility');
    expect(withCreate).toContain('Create workspace');
    expect(withCreate).not.toContain('aria-label="Create workspace"');
    expect(withCreate).not.toContain('role="dialog"');

    const withoutCreate = renderChooser({
      teams: [
        { teamId: 't1', orgId: 'o1', name: 'Backend Team', role: 'member' },
        { teamId: 't2', orgId: 'o1', name: 'Frontend Team', role: 'member' },
      ],
      pending_invites: [],
      can_create_org: true,
    });
    expect(withoutCreate).not.toContain('Workspace name');
    expect(withoutCreate).not.toContain('aria-label="Create workspace"');
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

  // Gap-fix B Task 2 (design §11.4): team_hint deep-link/switch preselect — rides the same
  // auto-select code path/UI as the single-team auto-skip above.
  describe('team_hint preselect', () => {
    const twoTeams: WorkspaceChoices = {
      teams: [
        { teamId: 't1', orgId: 'o1', name: 'Backend Team', role: 'member', slug: 'backend-team' },
        { teamId: 't2', orgId: 'o1', name: 'Design', role: 'owner', slug: 'design' },
      ],
      pending_invites: [],
      can_create_org: false,
      creatable_orgs: [],
    };

    it('auto-selects the hinted team when it matches by teamId', () => {
      const html = renderChooser(twoTeams, 'jo@example.com', 't2');

      expect(html).not.toContain('Choose a workspace');
      expect(html).toContain('Signing you in');
    });

    it('auto-selects the hinted team when it matches by slug', () => {
      const html = renderChooser(twoTeams, 'jo@example.com', 'design');

      expect(html).not.toContain('Choose a workspace');
      expect(html).toContain('Signing you in');
    });

    it("renders the chooser normally when the hint matches no team in this user's own choices", () => {
      const html = renderChooser(twoTeams, 'jo@example.com', 'not-a-real-team');

      expect(html).toContain('Choose a workspace');
      expect(html).toContain('Backend Team');
      expect(html).toContain('Design');
    });
  });

  // “Org and team should be different — org is a level above”: the page lists workspace groups,
  // while one card-corner action opens a destination picker backed only by creatable_orgs.
  it('renders one opaque, card-corner create control for server-marked organisations', () => {
    const html = renderChooser({
      teams: [
        { teamId: 't1', orgId: 'o1', name: 'General', role: 'admin', orgName: 'Acme' },
        { teamId: 't2', orgId: 'o2', name: 'General', role: 'member', orgName: 'Globex' },
      ],
      pending_invites: [],
      can_create_org: false,
      creatable_orgs: [{ orgId: 'o1', orgName: 'Acme' }],
    });

    expect(html).toContain('Acme');
    expect(html).toContain('Globex');
    // The org headings remain <h2>s so screen readers can jump between workspace groups.
    expect(html).toMatch(/<h2[^>]*>Acme<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>Globex<\/h2>/);
    expect(html).toContain('aria-label="Create workspace"');
    // It overlaps the outer chooser card, never the first workspace row.
    expect(html).toContain('absolute -right-[31px] -top-[26px] z-10 flex h-12 w-12');
    expect(html).toContain('flex h-10 w-10 items-center justify-center rounded-full');
    expect(html).toContain('bg-[var(--uoa-color-surface)]');
    // The popup stays closed on the server, so hydration matches and no keyboard opens on arrival.
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
  });

  // Two teams, because a single-team/no-invite payload auto-selects and never renders the chooser
  // (design §11.2) — creation is offered to users who actually land on this screen.
  it('offers creation for an org the user has no workspace in yet', () => {
    const html = renderChooser({
      teams: [
        { teamId: 't1', orgId: 'o1', name: 'General', role: 'admin', orgName: 'Acme' },
        { teamId: 't2', orgId: 'o1', name: 'Support', role: 'admin', orgName: 'Acme' },
      ],
      pending_invites: [],
      can_create_org: false,
      creatable_orgs: [{ orgId: 'o2', orgName: 'Initech' }],
    });

    expect(html).toContain('aria-label="Create workspace"');
    // Initech is a valid popup destination, not an empty workspace-list section.
    expect(html).not.toMatch(/<h2[^>]*>Initech<\/h2>/);
  });

  it('renders the workspace avatar image rather than the initials badge', () => {
    const html = renderChooser({
      teams: [
        {
          teamId: 't1',
          orgId: 'o1',
          name: 'Backend Team',
          role: 'member',
          avatarImageUrl: '/teams/t1/avatar',
        },
        { teamId: 't2', orgId: 'o1', name: 'Frontend Team', role: 'member' },
      ],
      pending_invites: [],
      can_create_org: false,
    });

    expect(html).toContain('src="/teams/t1/avatar"');
  });
});
