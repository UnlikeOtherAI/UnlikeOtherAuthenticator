import type { LoginLog } from '../features/admin/types';

export function activityTime(log: LoginLog) {
  return log.occurredAt ?? `${log.ts.replace(' ', 'T')}Z`;
}
export function loginCsv(logs: LoginLog[]) {
  const cell = (value: string | null | undefined) => {
    const safe = /^[=+\-@\t\r]/.test(value ?? '') ? `'${value}` : value ?? '';
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows = logs.map((log) => [activityTime(log), log.user, log.userId, log.domain, log.method, log.ip, log.userAgent]);
  return [['Time (UTC)', 'User', 'User ID', 'Service', 'Method', 'IP', 'User agent'], ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
}
