import type { IconName } from '../components/icons/Icon';

export type NavItem = {
  label: string;
  path: string;
  icon: IconName;
  badgeKey?: 'domains' | 'orgs' | 'users' | 'teams';
};

export type NavSection = {
  label: string;
  items: NavItem[];
};

export const navSections: NavSection[] = [
  {
    label: 'Overview',
    items: [{ label: 'Dashboard', path: '/dashboard', icon: 'grid' }],
  },
  {
    label: 'Configuration',
    items: [{ label: 'Secrets', path: '/secrets', icon: 'globe', badgeKey: 'domains' }],
  },
  {
    label: 'Directory',
    items: [
      { label: 'Domains', path: '/domains', icon: 'globe', badgeKey: 'domains' },
      { label: 'Organisations', path: '/organisations', icon: 'building', badgeKey: 'orgs' },
      { label: 'Teams', path: '/teams', icon: 'users', badgeKey: 'teams' },
      { label: 'Users', path: '/users', icon: 'user', badgeKey: 'users' },
    ],
  },
  {
    label: 'Security',
    items: [
      { label: 'Login Logs', path: '/logs', icon: 'logs' },
      { label: 'Connection Errors', path: '/connection-errors', icon: 'alert' },
    ],
  },
  {
    label: 'Flags',
    items: [{ label: 'Feature Flags', path: '/feature-flags', icon: 'key' }],
  },
  {
    label: 'System',
    items: [{ label: 'Settings', path: '/settings', icon: 'settings' }],
  },
];

export function navLabelForPath(pathname: string) {
  if (pathname.startsWith('/organisations/') && pathname.includes('/teams/')) {
    return 'Team';
  }

  if (pathname.startsWith('/organisations/')) {
    return 'Organisation';
  }

  if (pathname.startsWith('/domains/')) {
    return 'Domain';
  }

  if (pathname.startsWith('/feature-flags/') && pathname.includes('/groups/')) {
    return 'Audience Group';
  }

  if (pathname.startsWith('/feature-flags/')) {
    return 'Feature Flags';
  }

  if (pathname.startsWith('/users/')) {
    return 'User';
  }

  const item = navSections.flatMap((section) => section.items).find((entry) => entry.path === pathname);
  return item?.label ?? 'Dashboard';
}
