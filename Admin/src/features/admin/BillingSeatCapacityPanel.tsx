import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';

import { Button } from '../../components/ui/Button';
import { DataTable, PaginationFooter, Td, usePagination } from '../../components/ui/Table';
import type { BillingSeatSubscription } from '../../schemas/billing-seat-capacity';
import { billingAdminService } from '../../services/billing-admin-service';
import { useAdminUi } from '../shell/admin-ui';
import { billingLabel, billingUtcDate } from './billing-format';

function CapacityRow({ subscription, onChanged }: {
  subscription: BillingSeatSubscription;
  onChanged: () => Promise<void>;
}) {
  const [quantity, setQuantity] = useState(String(subscription.current_capacity ?? ''));
  const pending = subscription.capacity_revisions.find(
    (revision) => new Date(revision.effective_at).getTime() > Date.now(),
  );
  const { confirm } = useAdminUi();
  const change = useMutation({
    mutationFn: (value: number) => billingAdminService.changeSeatCapacity(subscription.id, value),
    onSuccess: onChanged,
  });
  const target = Number(quantity);
  const valid = !pending && /^\d+$/.test(quantity) && Number.isSafeInteger(target) && target > 0 &&
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
          {subscription.team?.name ?? 'Entire organisation'} · {billingLabel(subscription.source)}
        </span>
      </Td>
      <Td>{billingLabel(subscription.seat_policy)}</Td>
      <Td>{billingLabel(subscription.seat_charge_timing)}</Td>
      <Td>{subscription.baseline_member_count ?? 'Pending evidence'}</Td>
      <Td>{subscription.current_capacity ?? '—'}</Td>
      <Td>
        {subscription.seat_policy === 'fixed' && !subscription.ended_at ? (
          <div className="flex min-w-32 flex-col items-start gap-2">
            <input aria-label={`Purchased seats for ${subscription.organisation.name}`}
              className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
              inputMode="numeric" value={quantity} disabled={Boolean(pending)}
              onChange={(event) => setQuantity(event.target.value)} />
            {pending ? <span className="text-xs text-gray-600">
              {pending.quantity} seats scheduled for {billingUtcDate(pending.effective_at)}.
            </span> : null}
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
  const { pageItems, pagination } = usePagination(data, 10, { key: 'seat_subscriptions_page' });
  return (
    <section className="mt-6 space-y-2 pb-5">
      <h3 className="px-5 text-sm font-semibold text-gray-900">Seat subscriptions</h3>
      <p className="px-5 text-xs text-gray-500">
        Fixed capacity applies to active members and pending invitations in this team or organisation.
      </p>
      {error ? <p className="px-5 text-sm text-red-600">Seat subscriptions could not be loaded.</p> : null}
      <DataTable headers={['Scope', 'Policy', 'Timing', 'Baseline', 'Purchased', 'Capacity']}>
        {pageItems.map((subscription) => (
          <CapacityRow key={subscription.id} subscription={subscription}
            onChanged={() => queryClient.invalidateQueries({ queryKey: key })} />
        ))}
        {!isLoading && data.length === 0 ? <tr><Td colSpan={6} className="text-gray-400">
          This product has no seat subscription.
        </Td></tr> : null}
      </DataTable>
      <PaginationFooter {...pagination} />
    </section>
  );
}
