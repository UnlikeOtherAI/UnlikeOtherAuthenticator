import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { FieldShell, TextField } from '../../components/ui/FormFields';
import { adminService } from '../../services/admin-service';
import { useAdminUi } from '../shell/admin-ui';
import type { UserSummary } from './types';

function localDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function AccountExpiryPanel({ user }: { user: UserSummary }) {
  const [date, setDate] = useState(() => localDateTime(user.accountExpiresAt));
  const [error, setError] = useState('');
  const queryClient = useQueryClient();
  const { confirm } = useAdminUi();
  const request = user.accountRenewalRequest?.status === 'pending' ? user.accountRenewalRequest : null;
  useEffect(() => { setDate(localDateTime(user.accountExpiresAt)); }, [user.id, user.accountExpiresAt]);
  const mutation = useMutation({
    mutationFn: (action: 'approve' | 'decline' | 'save' | 'clear') => {
      if (action === 'approve' && request) return adminService.reviewAccountRenewal(request.id, 'approve', new Date(date).toISOString());
      if (action === 'decline' && request) return adminService.reviewAccountRenewal(request.id, 'decline');
      return adminService.setUserExpiry(user.id, action === 'clear' ? null : new Date(date).toISOString());
    },
    onSuccess: async () => { setError(''); await queryClient.invalidateQueries({ queryKey: ['admin'] }); },
    onError: () => setError('Could not update access. Refresh the user and try again.'),
  });
  const validDate = Boolean(date && Number.isFinite(new Date(date).getTime()) && new Date(date) > new Date());
  const active = user.status === 'active' || user.status === 'expired';
  return <Card className="mb-5 p-5">
    <h2 className="text-sm font-semibold text-gray-900">Account expiry</h2>
    <p className="mt-2 text-sm text-gray-600">{user.accountExpiresAt
      ? `Access ${user.status === 'expired' ? 'ended' : 'ends'} ${new Date(user.accountExpiresAt).toLocaleString()}.`
      : 'This account has no expiry date.'}</p>
    {request ? <p role="status" className="mt-3 text-sm text-gray-900">
      Renewal requested {new Date(request.requestedAt).toLocaleString()}. Set a new date to approve, or decline the request.
    </p> : null}
    {active ? <div className="mt-4 space-y-3">
      <FieldShell label="New expiry date and time" hint="Uses your local time. Choose a future date.">
        <TextField type="datetime-local" value={date} onChange={event => setDate(event.target.value)} />
      </FieldShell>
      <div className="flex flex-wrap gap-2">
        <Button disabled={mutation.isPending || !validDate} onClick={() => mutation.mutate(request ? 'approve' : 'save')}>
          {request ? 'Approve renewal' : 'Save expiry'}
        </Button>
        {request ? <Button disabled={mutation.isPending} onClick={() => confirm('Decline renewal request?',
          `The expiry for ${user.email} will remain in place.`, async () => { await mutation.mutateAsync('decline'); })}>
          Decline request
        </Button> : user.accountExpiresAt ? <Button disabled={mutation.isPending} onClick={() => confirm('Remove account expiry?',
          `${user.email} will keep access until another account restriction applies.`, async () => { await mutation.mutateAsync('clear'); })}>
          Remove expiry
        </Button> : null}
      </div>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    </div> : null}
  </Card>;
}
