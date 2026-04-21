import { Badge } from './Badge';
import type { AuthMethod, EntityStatus, UoaRole } from '../../features/admin/types';

export function StatusBadge({ status }: { status: EntityStatus | UoaRole | 'On' | 'Off' | 'OK' | 'FAIL' | 'Default' | 'Enabled' | 'Disabled' }) {
  const variant = {
    active: 'green',
    disabled: 'red',
    banned: 'red',
    owner: 'purple',
    admin: 'blue',
    member: 'slate',
    On: 'green',
    Off: 'slate',
    OK: 'green',
    FAIL: 'red',
    Default: 'blue',
    Enabled: 'green',
    Disabled: 'slate',
  } as const;

  return <Badge variant={variant[status]}>{status}</Badge>;
}

export function MethodBadge({ method }: { method: AuthMethod }) {
  const variant = method === 'google' || method === 'facebook' || method === 'linkedin' || method === 'microsoft' ? 'blue' : 'slate';

  return <Badge variant={variant}>{method}</Badge>;
}
