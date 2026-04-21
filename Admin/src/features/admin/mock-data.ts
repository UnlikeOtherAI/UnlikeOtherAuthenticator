import type { AdminData, AppFlagSummary, FeatureAudienceGroup, FeatureFlagDefinition, FeaturePlatform, KillSwitchEntry, OrganisationMember, PreapprovedMember, Team, UserSummary } from './types';
import { createFeaturePlatform } from './platforms';

const acmeMembers: OrganisationMember[] = [
  member('u101', 'Alice Chen', 'alice@acme.com', 'owner', ['General', 'Backend'], { General: 'member', Backend: 'admin' }, true, '2 min ago', 'google'),
  member('u102', 'Bob Smith', 'bob@acme.com', 'admin', ['General', 'Frontend'], { General: 'member', Frontend: 'admin' }, false, '1 hour ago', 'email'),
  member('u103', 'Carol Davis', 'carol@acme.com', 'member', ['General', 'Backend'], { General: 'member', Backend: 'member' }, true, '3 days ago', 'email'),
  member('u104', 'Dan Lee', 'dan@acme.com', 'member', ['General', 'DevOps'], { General: 'member', DevOps: 'admin' }, false, '1 week ago', 'github'),
  member('u105', 'Eva Torres', 'eva@acme.com', 'member', ['General', 'QA'], { General: 'member', QA: 'admin' }, true, '2 days ago', 'google'),
];

const designMembers: OrganisationMember[] = [
  member('u201', 'Emily Park', 'emily@acme.com', 'owner', ['General', 'Brand'], { General: 'member', Brand: 'admin' }, true, '30 min ago', 'google'),
  member('u202', 'Frank Wu', 'frank@acme.com', 'admin', ['General', 'UX Research'], { General: 'member', 'UX Research': 'admin' }, false, '2 days ago', 'email'),
  member('u203', 'Grace Kim', 'grace@acme.com', 'member', ['General', 'Brand'], { General: 'member', Brand: 'member' }, true, '5 hours ago', 'email'),
];

const widgetsMembers: OrganisationMember[] = [
  member('u301', 'Carol Johnson', 'carol@widgets.io', 'owner', ['General', 'Platform'], { General: 'member', Platform: 'admin' }, true, '1 day ago', 'email'),
  member('u302', 'Dave Brown', 'dave@widgets.io', 'admin', ['General', 'Integrations'], { General: 'member', Integrations: 'admin' }, true, '4 hours ago', 'email'),
  member('u303', 'Eve Martinez', 'eve@widgets.io', 'member', ['General', 'Mobile'], { General: 'member', Mobile: 'member' }, false, '2 hours ago', 'github'),
  member('u304', 'Henry Park', 'henry@widgets.io', 'member', ['General', 'Platform', 'Integrations'], { General: 'member', Platform: 'member', Integrations: 'member' }, true, '6 hours ago', 'email'),
];

const startupMembers: OrganisationMember[] = [
  member('u401', 'Ian Chen', 'ian@startup.dev', 'owner', ['General', 'Product'], { General: 'member', Product: 'admin' }, false, '1 hour ago', 'google'),
  member('u402', 'Julia Ross', 'julia@startup.dev', 'member', ['General', 'Product'], { General: 'member', Product: 'member' }, false, '3 hours ago', 'email'),
];

const fordMembers: OrganisationMember[] = [
  member('u501', 'James Ford', 'james.ford@ford.com', 'owner', ['General'], { General: 'admin' }, true, 'Yesterday', 'microsoft'),
];

export const mockAdminData: AdminData = {
  stats: { users: 1247, domains: 12, orgs: 34, loginsToday: 389 },
  domains: [
    { id: 'd1', name: 'app.acme.com', label: 'Acme App', secretAge: '12 days', secretOld: false, users: 487, orgs: 8, status: 'active', created: '2024-01-15', hash: 'a3f8d2c1...' },
    { id: 'd2', name: 'widgets.io', label: 'Widgets', secretAge: '89 days', secretOld: true, users: 312, orgs: 5, status: 'active', created: '2023-11-02', hash: 'b7e2f9a4...' },
    { id: 'd3', name: 'portal.example.com', label: 'Example Portal', secretAge: '5 days', secretOld: false, users: 198, orgs: 3, status: 'active', created: '2024-03-01', hash: 'c1d4e8b3...' },
    { id: 'd4', name: 'startup.dev', label: 'Startup Dev', secretAge: '22 days', secretOld: false, users: 104, orgs: 2, status: 'active', created: '2024-02-10', hash: 'e4b7c9f1...' },
    { id: 'd5', name: 'old-product.com', label: 'Old Product', secretAge: null, secretOld: false, users: 89, orgs: 2, status: 'disabled', created: '2023-06-10', hash: 'd9c3a7e2...' },
  ],
  organisations: [
    org('o1', 'Acme Engineering', 'acme-engineering', 'Jan 15, 2024', acmeMembers[0], [
      team('t11', 'o1', 'General', 'All members', true, 42),
      team('t12', 'o1', 'Backend', 'Backend engineers', false, 14),
      team('t13', 'o1', 'Frontend', 'Frontend engineers', false, 11),
      team('t14', 'o1', 'DevOps', 'Infrastructure', false, 6),
      team('t15', 'o1', 'QA', 'Quality assurance', false, 5),
    ], acmeMembers, [
      { id: 'pa1', email: 'new.backend@acme.com', role: 'member', targetTeam: 'Backend', method: 'EMAIL', status: 'pending', created: 'Apr 18, 2026' },
      { id: 'pa2', email: 'platform.admin@acme.com', role: 'admin', targetTeam: 'General', method: 'ANY', status: 'pending', created: 'Apr 17, 2026' },
      { id: 'pa3', email: 'eva@acme.com', role: 'member', targetTeam: 'QA', method: 'GOOGLE', status: 'claimed', created: 'Apr 10, 2026' },
    ]),
    org('o2', 'Acme Design', 'acme-design', 'Feb 3, 2024', designMembers[0], [
      team('t21', 'o2', 'General', 'All members', true, 18),
      team('t22', 'o2', 'Brand', 'Brand design', false, 8),
      team('t23', 'o2', 'UX Research', 'User experience', false, 7),
    ], designMembers, [
      { id: 'pa4', email: 'contractor@acme.com', role: 'member', targetTeam: 'Brand', method: 'ANY', status: 'pending', created: 'Apr 16, 2026' },
    ]),
    org('o3', 'Widgets Core', 'widgets-core', 'Nov 2, 2023', widgetsMembers[0], [
      team('t31', 'o3', 'General', 'All members', true, 91),
      team('t32', 'o3', 'Platform', 'Core platform', false, 22),
      team('t33', 'o3', 'Integrations', 'Third-party integrations', false, 18),
      team('t34', 'o3', 'Mobile', 'Mobile apps', false, 15),
    ], widgetsMembers, [
      { id: 'pa5', email: 'integrations@widgets.io', role: 'admin', targetTeam: 'Integrations', method: 'EMAIL', status: 'pending', created: 'Apr 15, 2026' },
    ]),
    org('o4', 'Startup Alpha', 'startup-alpha', 'Feb 10, 2024', startupMembers[0], [
      team('t41', 'o4', 'General', 'All members', true, 12),
      team('t42', 'o4', 'Product', 'Product team', false, 5),
    ], startupMembers, []),
    org('o5', 'Ford Enterprise', 'ford-enterprise', 'Mar 1, 2024', fordMembers[0], [
      team('t51', 'o5', 'General', 'All employees', true, 1),
      team('t52', 'o5', 'Engineering', 'Engineering staff', false, 0),
    ], fordMembers, [
      { id: 'pa6', email: 'employee@ford.com', role: 'member', targetTeam: 'General', method: 'MICROSOFT', status: 'pending', created: 'Apr 19, 2026' },
    ]),
  ],
  users: [
    user('u101', 'Alice Chen', 'alice@acme.com', ['app.acme.com'], true, '2 min ago', 'active', 'google', 'Jan 15, 2024'),
    user('u102', 'Bob Smith', 'bob@acme.com', ['app.acme.com'], false, '1 hour ago', 'active', 'email', 'Jan 20, 2024'),
    user('u103', 'Carol Davis', 'carol@acme.com', ['app.acme.com', 'widgets.io'], true, '1 hour ago', 'active', 'email', 'Feb 3, 2024'),
    user('u104', 'Dan Lee', 'dan@acme.com', ['app.acme.com'], false, '1 week ago', 'active', 'github', 'Mar 1, 2024'),
    user('u201', 'Emily Park', 'emily@acme.com', ['app.acme.com'], true, '30 min ago', 'active', 'google', 'Feb 3, 2024'),
    user('u301', 'Carol Johnson', 'carol@widgets.io', ['widgets.io'], true, '1 day ago', 'active', 'email', 'Nov 2, 2023'),
    user('u302', 'Dave Brown', 'dave@widgets.io', ['widgets.io'], true, '4 hours ago', 'active', 'email', 'Nov 5, 2023'),
    user('u303', 'Eve Martinez', 'eve@widgets.io', ['widgets.io'], false, '2 hours ago', 'active', 'github', 'Nov 8, 2023'),
    user('u304', 'Henry Park', 'henry@widgets.io', ['widgets.io'], true, '6 hours ago', 'active', 'email', 'Nov 12, 2023'),
    user('u999', null, 'spam@evil.example', ['portal.example.com'], false, 'Never', 'banned', 'email', 'Apr 4, 2026'),
  ],
  logs: [
    { id: 'l1', ts: '2026-04-07 09:42:11', user: 'alice@acme.com', domain: 'app.acme.com', method: 'google', ip: '84.198.12.xx', userAgent: 'Chrome 123 / macOS', result: 'ok' },
    { id: 'l2', ts: '2026-04-07 09:39:05', user: 'bob@widgets.io', domain: 'widgets.io', method: 'email', ip: '31.41.59.xx', userAgent: 'Firefox 124 / Windows', result: 'ok' },
    { id: 'l3', ts: '2026-04-07 09:31:22', user: 'carol@example.com', domain: 'portal.example.com', method: 'email', ip: '192.168.1.xx', userAgent: 'Safari 17 / iOS', result: 'ok' },
    { id: 'l4', ts: '2026-04-07 09:18:44', user: null, domain: 'app.acme.com', method: 'email', ip: '185.220.101.xx', userAgent: 'python-requests/2.31', result: 'fail' },
    { id: 'l5', ts: '2026-04-07 09:05:11', user: 'dan@acme.com', domain: 'app.acme.com', method: 'github', ip: '77.99.201.xx', userAgent: 'Chrome 123 / Linux', result: 'ok' },
    { id: 'l6', ts: '2026-04-07 08:47:33', user: 'eve@startup.dev', domain: 'startup.dev', method: 'email', ip: '93.184.216.xx', userAgent: 'Edge 123 / Windows', result: 'ok' },
  ],
  bans: {
    emails: [
      { id: 'be1', value: 'spam@evil.example', bannedAt: '3 days ago', reason: 'Spam' },
      { id: 'be2', value: 'abuse@tempmail.example', bannedAt: '1 week ago', reason: 'Abuse' },
      { id: 'be3', value: 'test123@disposable.example', bannedAt: '2 weeks ago', reason: 'Disposable' },
    ],
    patterns: [
      { id: 'bp1', value: '*@tempmail.example', bannedAt: '1 month ago', hits: 42 },
      { id: 'bp2', value: '*@disposable.example', bannedAt: '3 weeks ago', hits: 17 },
      { id: 'bp3', value: '*+test*@*', bannedAt: '5 days ago', hits: 3 },
    ],
    ips: [
      { id: 'bi1', value: '185.220.101.0/24', label: 'Tor exit range', bannedAt: '1 week ago', hits: 128, expiry: null },
      { id: 'bi2', value: '45.12.33.199', label: 'Brute force source', bannedAt: '2 days ago', hits: 7, expiry: 'Apr 14, 2026' },
      { id: 'bi3', value: '91.108.56.0/22', label: 'Known spam subnet', bannedAt: '3 weeks ago', hits: 54, expiry: null },
    ],
    users: [{ id: 'bu1', value: 'spam@evil.example', label: 'portal.example.com', bannedAt: 'Apr 4, 2026', reason: 'Spam account' }],
  },
  apps: [
    app(
      'app1',
      'Acme Main App',
      'com.acme.main',
      'app.acme.com',
      'Acme Engineering',
      'o1',
      'ios',
      ['app.acme.com'],
      true,
      true,
      [
        platform('ios', { name: 'iOS', identifier: 'com.acme.main.ios' }),
        platform('android', { name: 'Android', identifier: 'com.acme.main.android' }),
        platform('web', { name: 'Web', identifier: 'app.acme.com' }),
      ],
      [
        flag('f1', 'new_checkout', 'New checkout flow', true, 'all', [], 'Apr 20, 2026'),
        flag('f2', 'native_billing', 'Native billing handoff', false, 'selected', ['ios', 'android'], 'Apr 18, 2026'),
        flag('f3', 'web_beta_nav', 'Web dashboard navigation test', false, 'selected', ['web'], 'Apr 17, 2026'),
        flag('f4', 'instant_refunds', 'Instant refund controls', false, 'all', [], 'Apr 14, 2026'),
      ],
      [
        killSwitch('ks1', 'Block legacy iOS builds', 'selected', ['ios'], 'hard', 'versionName', 'lt', '2.1.0', null, 'semver', '2.1.0', true, 100, 300, 'Apr 20, 2026'),
        killSwitch('ks2', 'Warn Android beta users', 'selected', ['android'], 'soft', 'versionCode', 'range', '104', '118', 'integer', '120', true, 40, 900, 'Apr 18, 2026'),
      ],
      [
        audienceGroup('ag1', 'Checkout beta testers', 'Selected users for new checkout and billing feature tests.', 'selected', ['u101', 'u102', 'u103'], 'selected', ['ios', 'android'], ['f1', 'f2'], [], true, 'Apr 20, 2026'),
        audienceGroup('ag2', 'All mobile users', 'Broad mobile audience for versioned kill-switch validation.', 'all', [], 'selected', ['ios', 'android'], [], ['ks1', 'ks2'], true, 'Apr 19, 2026'),
      ],
    ),
    app(
      'app2',
      'Widgets Dashboard',
      'io.widgets.dashboard',
      'widgets.io',
      'Widgets Core',
      'o3',
      'web',
      ['widgets.io'],
      true,
      false,
      [
        platform('web', { name: 'Web', identifier: 'widgets.io' }),
        platform('ios', { name: 'iOS companion', identifier: 'io.widgets.dashboard.ios' }),
        platform('android', { name: 'Android companion', identifier: 'io.widgets.dashboard.android' }),
        platform('macos', { id: 'mac', name: 'Mac desktop', identifier: 'io.widgets.dashboard.mac' }),
        platform('windows', { id: 'pc', name: 'PC desktop', identifier: 'io.widgets.dashboard.windows' }),
        platform('iot', { id: 'kiosk', name: 'IoT kiosk', identifier: 'widgets.kiosk' }),
      ],
      [
        flag('f5', 'integrations_v2', 'New integrations workspace', true, 'all', [], 'Apr 19, 2026'),
        flag('f6', 'mobile_uploads', 'Mobile upload queue', false, 'selected', ['ios'], 'Apr 12, 2026'),
        flag('f7', 'usage_export', 'Usage export beta', false, 'selected', ['web'], 'Apr 9, 2026'),
        flag('f8', 'android_quick_scan', 'Android companion scanner', false, 'selected', ['android'], 'Apr 8, 2026'),
        flag('f9', 'desktop_command_center', 'Desktop command center layout', false, 'selected', ['mac', 'pc'], 'Apr 7, 2026'),
        flag('f10', 'kiosk_pairing', 'IoT kiosk pairing flow', false, 'selected', ['kiosk'], 'Apr 6, 2026'),
      ],
      [
        killSwitch('ks3', 'Legacy companion warning', 'selected', ['ios'], 'info', 'buildNumber', 'lte', '80', null, 'integer', '1.4.0', true, 10, 1800, 'Apr 15, 2026'),
        killSwitch('ks4', 'Block unsupported desktop shells', 'selected', ['mac', 'pc'], 'hard', 'versionName', 'lt', '3.0.0', null, 'semver', '3.0.0', true, 80, 600, 'Apr 14, 2026'),
        killSwitch('ks5', 'Pause kiosk onboarding', 'selected', ['kiosk'], 'maintenance', 'versionCode', 'lte', '42', null, 'integer', '44', false, 60, 300, 'Apr 10, 2026'),
      ],
      [
        audienceGroup('ag3', 'Widgets QA cohort', 'Known users used to test integrations and iOS companion gating.', 'selected', ['u301', 'u303', 'u304'], 'selected', ['web', 'ios'], ['f5', 'f6'], ['ks3'], true, 'Apr 19, 2026'),
        audienceGroup('ag4', 'All dashboard users', 'Every eligible Widgets Dashboard user across all configured platforms.', 'all', [], 'all', [], ['f5'], [], true, 'Apr 17, 2026'),
        audienceGroup('ag5', 'Desktop pilot', 'Internal users testing desktop shells before public release.', 'selected', ['u302', 'u304'], 'selected', ['mac', 'pc'], ['f9'], ['ks4'], true, 'Apr 16, 2026'),
        audienceGroup('ag6', 'Kiosk rollout', 'Users validating custom IoT platform onboarding.', 'selected', ['u301'], 'selected', ['kiosk'], ['f10'], ['ks5'], false, 'Apr 12, 2026'),
      ],
    ),
    app(
      'app3',
      'Startup Portal',
      'dev.startup.portal',
      'startup.dev',
      'Startup Alpha',
      'o4',
      'web',
      ['startup.dev'],
      false,
      false,
      [
        platform('web', { name: 'Web', identifier: 'startup.dev' }),
      ],
      [],
      [],
      [],
    ),
  ],
};

function app(
  id: string,
  name: string,
  identifier: string,
  domain: string,
  org: string,
  orgId: string,
  platformKind: AppFlagSummary['platform'],
  domains: string[],
  flagsEnabled: boolean,
  matrixEnabled: boolean,
  platforms: FeaturePlatform[],
  flagDefinitions: FeatureFlagDefinition[],
  killSwitches: KillSwitchEntry[],
  audienceGroups: FeatureAudienceGroup[] = [],
): AppFlagSummary {
  return {
    id,
    name,
    identifier,
    domain,
    org,
    orgId,
    platform: platformKind,
    domains,
    storeUrl: platformKind === 'ios' ? 'https://apps.apple.com/app/example/id123456789' : undefined,
    offlinePolicy: 'allow',
    pollIntervalSeconds: 300,
    flagsEnabled,
    matrixEnabled,
    flags: flagDefinitions.length,
    platforms,
    flagDefinitions,
    killSwitches,
    audienceGroups,
    status: 'active',
  };
}

function platform(kind: FeaturePlatform['kind'], options: { id?: string; name?: string; identifier?: string } = {}): FeaturePlatform {
  return createFeaturePlatform(kind, options);
}

function flag(
  id: string,
  key: string,
  description: string,
  defaultState: boolean,
  platformMode: FeatureFlagDefinition['platformMode'],
  platformIds: string[],
  updated: string,
): FeatureFlagDefinition {
  return { id, key, description, defaultState, platformMode, platformIds, updated };
}

function killSwitch(
  id: string,
  name: string,
  platformMode: KillSwitchEntry['platformMode'],
  platformIds: string[],
  type: KillSwitchEntry['type'],
  versionField: KillSwitchEntry['versionField'],
  operator: KillSwitchEntry['operator'],
  versionValue: string,
  versionMax: string | null,
  versionScheme: KillSwitchEntry['versionScheme'],
  latestVersion: string | undefined,
  active: boolean,
  priority: number,
  cacheTtl: number,
  updated: string,
): KillSwitchEntry {
  return { id, name, platformMode, platformIds, type, versionField, operator, versionValue, versionMax, versionScheme, latestVersion, active, priority, cacheTtl, updated };
}

function audienceGroup(
  id: string,
  name: string,
  description: string,
  userMode: FeatureAudienceGroup['userMode'],
  userIds: string[],
  platformMode: FeatureAudienceGroup['platformMode'],
  platformIds: string[],
  featureFlagIds: string[],
  killSwitchIds: string[],
  active: boolean,
  updated: string,
): FeatureAudienceGroup {
  return { id, name, description, userMode, userIds, platformMode, platformIds, featureFlagIds, killSwitchIds, active, updated };
}

function org(
  id: string,
  name: string,
  slug: string,
  created: string,
  owner: OrganisationMember,
  teams: Team[],
  members: OrganisationMember[],
  preapprovedMembers: PreapprovedMember[],
) {
  return { id, name, slug, created, owner: { id: owner.id, name: owner.name, email: owner.email }, teams, members, preapprovedMembers };
}

function team(id: string, orgId: string, name: string, description: string, isDefault: boolean, members: number): Team {
  return { id, orgId, name, description, isDefault, members };
}

function member(
  id: string,
  name: string,
  email: string,
  role: OrganisationMember['role'],
  teams: string[],
  teamRoles: OrganisationMember['teamRoles'],
  twofa: boolean,
  lastLogin: string,
  method: OrganisationMember['method'],
): OrganisationMember {
  return { id, name, email, role, teams, teamRoles, twofa, lastLogin, status: 'active', method };
}

function user(
  id: string,
  name: string | null,
  email: string,
  domains: string[],
  twofa: boolean,
  lastLogin: string,
  status: UserSummary['status'],
  method: UserSummary['method'],
  created: string,
): UserSummary {
  return { id, name, email, domains, twofa, lastLogin, status, method, created };
}
