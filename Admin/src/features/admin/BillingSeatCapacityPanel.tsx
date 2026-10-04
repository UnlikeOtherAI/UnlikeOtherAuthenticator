import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';

import { Button } from '../../components/ui/Button';
import { DataTable, Td } from '../../components/ui/Table';
import type { BillingSeatSubscription } from '../../schemas/billing-seat-capacity';
import { billingAdminService } from '../../services/billing-admin-service';
import { useAdminUi } from '../shell/admin-ui';

function CapacityRow({ subscription, onChanged }: {
  subscription: BillingSeatSubscription;
  onChanged: () => Promise<void>;
}) {
  const [quantity, setQuantity] = useState(String(subscription.current_capacity ?? ''));
  const { confirm } = useAdminUi();
  const change = useMutation({
    mutationFn: (value: number) => billingAdminService.changeSeatCapacity(subscription.id, value),
    onSuccess: onChanged,
  });
  const target = Number(quantity);
  const valid = /^\d+$/.test(quantity) && Number.isSafeInteger(target) && target > 0 &&
    target !== subscription.current_capacity;
  const timing = subscription.seat_charge_timing === 'full_month' &&
    target < (subscription.current_capacity ?? 0)
    ? 'The lower capacity starts next UTC month.'
    : 'The higher capacity starts now.';
  return (
    <tr>
      <Td>
        <Link className="text-blue-600 hover:underline"
          to={`/organisations/${encodeURIComponent(subscription.organisation.id)}`}>
          {subscription.organisation.name}
        </Link>
        <span className="block text-xs text-gray-500">
          {subscription.team?.name ?? 'Entire organisation'} · {subscription.source}
        </span>
      </Td>
      <Td className="capitalize">{subscription.seat_policy}</Td>
      <Td className="capitalize">{subscription.seat_charge_timing.replace('_', ' ')}</Td>
      <Td>{subscription.baseline_member_count ?? 'Pending evidence'}</Td>
      <Td>{subscription.current_capacity ?? '—'}</Td>
      <Td>
        {subscription.seat_policy === 'fixed' && !subscription.ended_at ? (
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label={`Purchased seats for ${subscription.organisation.name}`}
              className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
              inputMode="numeric" value={quantity}
              onChange={(event) => setQuantity(event.target.value)} />
            <Button size="sm" disabled={!valid || change.isPending}
              onClick={() => confirm('Change purchased seat capacity?', timing,
                () => change.mutateAsync(target))}>
              Save seats
            </Button>
            {change.error ? <span className="text-xs text-red-600">
              {change.error instanceof Error ? change.error.message : 'Capacity change refused.'}
            </span> : null}
          </div>
        ) : subscription.ended_at ? 'Ended' : 'Follows active members'}
      </Td>
    </tr>
  );
}

export function BillingSeatCapacityPanel({ serviceId }: { serviceId: string }) {
  const queryClient = useQueryClient();
  const key = ['admin', 'billing', 'seat-subscriptions', serviceId];
  const { data = [], isLoading, error } = useQuery({
    queryKey: key, queryFn: () => billingAdminService.listSeatSubscriptions(serviceId),
  });
  return (
    <section className="mt-6 space-y-2 px-5 pb-5">
      <h3 className="text-sm font-semibold text-gray-900">Seat subscriptions</h3>
      <p className="text-xs text-gray-500">
        Fixed capacity applies to active members and pending invitations in this team or organisation.
      </p>
      {error ? <p className="text-sm text-red-600">Seat subscriptions could not be loaded.</p> : null}
      <DataTable headers={['Scope', 'Policy', 'Timing', 'Baseline', 'Purchased', 'Capacity']}>
        {data.map((subscription) => (
          <CapacityRow key={subscription.id} subscription={subscription}
            onChanged={() => queryClient.invalidateQueries({ queryKey: key })} />
        ))}
        {!isLoading && data.length === 0 ? <tr><Td colSpan={6} className="text-gray-500">
          No seat subscriptions for this service.
        </Td></tr> : null}
      </DataTable>
    </section>
  );
}
