import { cn } from '../../utils/cn';

export type IconName =
  | 'alert'
  | 'back'
  | 'bell'
  | 'building'
  | 'check'
  | 'chevronRight'
  | 'close'
  | 'download'
  | 'globe'
  | 'grid'
  | 'key'
  | 'logs'
  | 'logout'
  | 'menu'
  | 'plus'
  | 'search'
  | 'settings'
  | 'shield'
  | 'user'
  | 'users';

type IconProps = {
  name: IconName;
  className?: string;
  title?: string;
};

const paths: Record<IconName, string[]> = {
  alert: ['M12 9v2m0 4h.01', 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z'],
  back: ['M10 19l-7-7m0 0l7-7m-7 7h18'],
  bell: ['M15 17h5l-1.4-1.4A2 2 0 0118 14.16V11a6 6 0 00-4-5.66V5a2 2 0 10-4 0v.34A6 6 0 006 11v3.16c0 .54-.21 1.05-.6 1.44L4 17h5', 'M15 17v1a3 3 0 11-6 0v-1'],
  building: ['M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16', 'M3 21h18', 'M9 7h1m-1 4h1m4-4h1m-1 4h1', 'M9 21v-6h6v6'],
  check: ['M5 13l4 4L19 7'],
  chevronRight: ['M9 5l7 7-7 7'],
  close: ['M6 18L18 6M6 6l12 12'],
  download: ['M12 10v6m0 0l-3-3m3 3l3-3', 'M4 20h16'],
  globe: ['M21 12a9 9 0 11-18 0 9 9 0 0118 0z', 'M3 12h18', 'M12 3c2 2.2 3 5.2 3 9s-1 6.8-3 9c-2-2.2-3-5.2-3-9s1-6.8 3-9z'],
  grid: ['M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6z', 'M14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6z', 'M4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2z', 'M14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z'],
  key: ['M15 7a2 2 0 012 2m4 0a6 6 0 01-7.74 5.74L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.59c0-.26.1-.52.29-.7l5.97-5.97A6 6 0 1121 9z'],
  logs: ['M9 12h6m-6 4h6', 'M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h5.59c.26 0 .52.1.7.29l5.42 5.42c.18.18.29.44.29.7V19a2 2 0 01-2 2z'],
  logout: ['M17 16l4-4m0 0l-4-4m4 4H7', 'M13 16v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1'],
  menu: ['M4 6h16M4 12h16M4 18h16'],
  plus: ['M12 4v16m8-8H4'],
  search: ['M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z'],
  settings: ['M10.33 4.32c.43-1.76 2.92-1.76 3.34 0a1.72 1.72 0 002.58 1.07c1.54-.94 3.3.82 2.36 2.36a1.72 1.72 0 001.07 2.58c1.76.42 1.76 2.91 0 3.34a1.72 1.72 0 00-1.07 2.58c.94 1.54-.82 3.3-2.36 2.36a1.72 1.72 0 00-2.58 1.07c-.42 1.76-2.91 1.76-3.34 0a1.72 1.72 0 00-2.58-1.07c-1.54.94-3.3-.82-2.36-2.36a1.72 1.72 0 00-1.07-2.58c-1.76-.43-1.76-2.92 0-3.34a1.72 1.72 0 001.07-2.58c-.94-1.54.82-3.3 2.36-2.36 1 .6 2.3.07 2.58-1.07z', 'M15 12a3 3 0 11-6 0 3 3 0 016 0z'],
  shield: ['M18.36 18.36A9 9 0 005.64 5.64m12.72 12.72A9 9 0 015.64 5.64m12.72 12.72L5.64 5.64'],
  user: ['M16 7a4 4 0 11-8 0 4 4 0 018 0z', 'M12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z'],
  users: ['M17 20h5v-2a3 3 0 00-5.36-1.86M17 20H7m10 0v-2c0-.66-.13-1.28-.36-1.86M7 20H2v-2a3 3 0 015.36-1.86M7 20v-2c0-.66.13-1.28.36-1.86m0 0a5 5 0 019.28 0M15 7a3 3 0 11-6 0 3 3 0 016 0z'],
};

export function Icon({ name, className, title }: IconProps) {
  return (
    <svg className={cn('h-4 w-4', className)} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      {paths[name].map((path) => (
        <path key={path} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={path} />
      ))}
    </svg>
  );
}
