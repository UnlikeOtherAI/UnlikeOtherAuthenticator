import type { IconName } from '../components/icons/Icon';
export type NavItem = { label: string; path: string; icon: IconName; badgeKey?: 'integrationRequests' };
export type NavSection = { label: string; items: NavItem[] };
export const navSections: NavSection[] = [
  { label: '', items: [{ label: 'Dashboard', path: '/dashboard', icon: 'grid' }] },
  { label: 'Directory', items: [
    { label: 'Users', path: '/users', icon: 'user' },
    { label: 'Organisations', path: '/organisations', icon: 'building' },
    { label: 'Teams', path: '/teams', icon: 'users' },
  ] },
  { label: 'Integrations', items: [
    { label: 'Website services', path: '/domains', icon: 'globe' },
    { label: 'Native apps', path: '/apps', icon: 'grid' },
    { label: 'Integration requests', path: '/integrations', icon: 'bell', badgeKey: 'integrationRequests' },
    { label: 'Delegation policies', path: '/delegations', icon: 'key' },
    { label: 'Feature flags', path: '/feature-flags', icon: 'key' },
  ] },
  { label: 'Billing', items: [{ label: 'Products & invoices', path: '/billing', icon: 'building' }] },
  { label: 'Security', items: [
    { label: 'Administrators', path: '/superusers', icon: 'users' },
    { label: 'Access reason templates', path: '/access-reasons', icon: 'alert' },
    { label: 'Access bans', path: '/bans', icon: 'alert' },
    { label: 'Automation API keys', path: '/api-keys', icon: 'key' },
  ] },
  { label: 'Activity', items: [
    { label: 'Login activity', path: '/logs', icon: 'logs' },
    { label: 'Connection errors', path: '/connection-errors', icon: 'alert' },
  ] },
];
export function navLabelForPath(pathname: string) {
  if (pathname.startsWith('/deletion-jobs/')) return 'Deletion progress';
  if (pathname.includes('/teams/') && pathname.startsWith('/organisations/')) return 'Team';
  const item = navSections.flatMap((section) => section.items).find((entry) => pathname === entry.path || pathname.startsWith(`${entry.path}/`));
  return item?.label ?? 'Dashboard';
}
