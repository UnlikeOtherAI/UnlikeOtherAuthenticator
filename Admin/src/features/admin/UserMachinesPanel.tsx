import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { machineService } from '../../services/machine-service';
import type { AdminMachine } from '../../schemas/machines';
import { useAdminUi } from '../shell/admin-ui';

const terminal = ['device_revoked', 'all_devices_revoked', 'credential_replay', 'lineage_invalid'];
const stopText = 'New access stops within 30 seconds after revocation is confirmed. Work already accepted may still finish or stop safely. Connecting again requires a new approval.';
const failureText = 'The revocation could not be confirmed. Current access is unknown. Try revoking again.';
function created(value: string) {
  return new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit',
    minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }).format(new Date(value));
}
export function UserMachinesPanel({ userId, personLabel }: { userId: string; personLabel: string }) {
  const queryKey = ['admin', 'user', userId, 'machines'];
  const query = useQuery({ queryKey, queryFn: () => machineService.list(userId) });
  const client = useQueryClient(); const { confirm } = useAdminUi();
  const mutation = useMutation({ mutationFn: (id: string | undefined) => machineService.revoke(userId, id),
    onSuccess: () => client.invalidateQueries({ queryKey }) });
  const data = query.isError ? [] : query.data?.data ?? [];
  const current = data.filter(row => !terminal.includes(row.reason));
  const history = data.filter(row => terminal.includes(row.reason));
  function rows(items: AdminMachine[], ended: boolean) {
    return items.map(row => <div key={row.enrollment_id} className="flex min-w-0 flex-col items-start gap-2 py-4">
      <p className="break-words text-sm font-medium">{row.device_name}</p>
      <p className="break-words text-xs text-gray-600">Requested by {row.client_domain}</p>
      <p className="break-words text-xs text-gray-600">{row.organization_name ?? 'Unavailable organisation'} · {row.team_name ?? 'Unavailable team'}</p>
      <p className="text-xs text-gray-600">Record created {created(row.created_at)}</p>
      <p className="w-full break-all text-xs text-gray-600">Approval reference: {row.enrollment_id}</p>
      <p className="text-xs text-gray-600">{ended ? 'Approval ended' : row.decision === 'allowed' ? 'Approved' :
        row.decision === 'access_removed' ? 'Team access removed' : row.decision === 'revoked' ? 'Approval stopped' : 'Approval needed'}</p>
      {!ended ? <Button className="self-start" disabled={mutation.isPending}
        onClick={() => confirm(`Revoke ${row.device_name} for ${personLabel}?`,
          `${row.organization_name ?? 'Unavailable organisation'} · ${row.team_name ?? 'Unavailable team'}. Requested by ${row.client_domain}. Record created ${created(row.created_at)}. Approval reference: ${row.enrollment_id}. ${stopText}`,
          async () => { await mutation.mutateAsync(row.enrollment_id); }, undefined, failureText)}>Revoke</Button> : null}
    </div>);
  }
  return <Card className="mb-5 p-5 pb-20">
    <h2 className="text-sm font-semibold text-gray-900">Computer connections</h2>
    <p className="mt-2 text-sm text-gray-600">Computer approvals for {personLabel} remain in place after an ordinary browser sign-out. Revoke an approval here to stop it.</p>
    {query.isPending ? <p role="status" className="mt-3 text-sm">Loading connections…</p> : null}
    {query.isError ? <div role="alert" className="mt-3 text-sm">Current computer access could not be loaded. <Button onClick={() => void query.refetch()}>Retry</Button></div> : null}
    {!query.isError && query.data?.data.length === 0 ? <p className="mt-3 text-sm text-gray-600">No computer approval records.</p> : null}
    {current.length ? <section className="mt-4" aria-label="Current and stopped approvals">
      <h3 className="text-sm font-medium text-gray-900">Current and stopped approvals</h3>
      <div className="divide-y divide-gray-100">{rows(current, false)}</div>
    </section> : null}
    {!query.isError && (current.length || query.data?.truncated) ? <section className="mt-4 border-t border-gray-100 pt-4">
      <h3 className="mb-3 text-sm font-medium text-gray-900">All computer approvals for {personLabel}</h3>
      <Button variant="danger" disabled={mutation.isPending} onClick={() => confirm(`Revoke all computer approvals for ${personLabel}?`,
        `This revokes ${personLabel}’s computer approvals across every product and team. Other people’s approvals and browser sessions are separate. ${stopText}`,
        async () => { await mutation.mutateAsync(undefined); }, undefined, failureText)}>Revoke all computer approvals</Button>
    </section> : null}
    {history.length ? <section className="mt-5 border-t border-gray-100 pt-4" aria-label="Ended approvals">
      <h3 className="text-sm font-medium text-gray-900">Ended approvals</h3>
      <div className="divide-y divide-gray-100">{rows(history, true)}</div>
    </section> : null}
    {!query.isError && query.data?.truncated ? <p className="mt-3 text-xs text-gray-600">Showing the latest 100 records. Revoke all applies to every computer approval for this person across all products and teams.</p> : null}
  </Card>;
}
