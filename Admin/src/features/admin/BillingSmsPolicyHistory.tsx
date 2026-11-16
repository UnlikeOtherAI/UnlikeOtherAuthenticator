import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { PaginationFooter, usePagination } from '../../components/ui/Table';
import type { SmsPolicies, SmsPolicyAlert } from '../../schemas/billing-sms-policies';
import { billingDateTime } from './billing-format';

type Route = SmsPolicies['routes'][number];
const routeSubject = (route: Route) => `${route.account_sid}:${route.country}:${route.direction}:${route.currency}`;

/** Open renewal-job conditions; each names the route or rate and what a person has to do. */
export function BillingSmsPolicyAlerts({ alerts }: { alerts: SmsPolicyAlert[] }) {
  if (!alerts.length) return null;
  return <Card className="space-y-3 border-amber-200 p-5"><h3 className="font-semibold text-gray-900">Needs attention</h3>
    {alerts.map((alert) => <div key={alert.id} role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
      <p>{alert.message}</p>
      <p className="mt-1 text-xs text-amber-700">Raised {billingDateTime(alert.opened_at)} by the renewal job</p>
    </div>)}
  </Card>;
}

type HistoryRecord =
  | { kind: 'fx'; value: SmsPolicies['fx'][number]; attention: boolean }
  | { kind: 'route'; value: Route; attention: boolean };

/** Accepted evidence, newest first; the newest record per route or rate carries its pending alert. */
export function BillingSmsPolicyHistory({ data, loading, failed, onReload }: {
  data: SmsPolicies | undefined; loading: boolean; failed: boolean; onReload: () => void;
}) {
  const alerted = new Set(data?.alerts.map((alert) => alert.subject));
  const seen = new Set<string>();
  const attention = (subject: string) => {
    const first = !seen.has(subject); seen.add(subject);
    return first && alerted.has(subject);
  };
  // Decided over the whole history before paging, so the alert stays on the newest record.
  const records: HistoryRecord[] = [
    ...(data?.fx ?? []).map((value) => ({ kind: 'fx' as const, value, attention: attention(value.policy) })),
    ...(data?.routes ?? []).map((value) => ({ kind: 'route' as const, value,
      attention: attention(routeSubject(value)) })),
  ];
  const { pageItems, pagination } = usePagination(records, 10, { key: 'sms_history_page' });
  return <Card className="space-y-4 p-5"><div className="flex items-center justify-between"><h3 className="font-semibold text-gray-900">Accepted evidence history</h3>
    <Button onClick={onReload}>Reload history</Button></div>
    {loading ? <p className="text-sm text-gray-500">Loading accepted policies...</p> : null}
    {failed ? <p role="alert" className="text-sm text-red-600">Could not load accepted policies. Reload history to retry.</p> : null}
    {data ? <>
      <p className="text-xs text-gray-500">Latest 50 currency policies and 100 route policies; immutable acceptance records.</p>
      {pageItems.map((record) => record.kind === 'fx' ? <div key={record.value.id} className="rounded-lg border border-gray-200 p-3 text-sm">
        <PolicyStatus expiresAt={record.value.expires_at} attention={record.attention} /> <strong>ECB · {record.value.rate_date} · USD/EUR {record.value.usd_per_eur}</strong>
        <EvidenceRecord source={record.value.source} digest={record.value.source_digest} expiresAt={record.value.expires_at}
          acceptedAt={record.value.accepted_at} actor={record.value.accepted_by_user_id} reason={record.value.acceptance_reason} />
      </div> : <div key={record.value.id} className="rounded-lg border border-gray-200 p-3 text-sm">
        <PolicyStatus expiresAt={record.value.expires_at} attention={record.attention} /> <strong>{record.value.country} · {record.value.direction} · {record.value.currency}</strong>
        <p className="mt-1 break-all font-mono text-xs">{record.value.account_sid} · segment {record.value.additional_per_segment} · message {record.value.additional_per_message}</p>
        <p className="mt-1 text-xs text-gray-600">{record.value.provider_price === null
          ? 'No account price recorded: renews only when a person accepts it again.'
          : `Account price ${record.value.currency} ${record.value.provider_price} at acceptance; renews automatically while the price does not rise.`}</p>
        <EvidenceRecord source={record.value.source} digest={record.value.evidence_digest} expiresAt={record.value.expires_at}
          acceptedAt={record.value.accepted_at} actor={record.value.accepted_by_user_id} reason={record.value.acceptance_reason} />
      </div>)}
      {records.length === 0 ? <p className="text-sm text-gray-500">No SMS policy has been accepted yet.</p> : null}
      <PaginationFooter {...pagination} />
    </> : null}
  </Card>;
}

function PolicyStatus({ expiresAt, attention }: { expiresAt: string; attention: boolean }) {
  const expired = Date.parse(expiresAt) <= Date.now();
  return <span className="inline-flex flex-wrap gap-1"><Badge variant={expired ? 'red' : 'green'}>{expired ? 'Expired' : 'Fresh'}</Badge>
    {attention ? <Badge variant="amber">Needs attention</Badge> : null}</span>;
}
function EvidenceRecord({ source, digest, expiresAt, acceptedAt, actor, reason }: {
  source: string; digest: string; expiresAt: string; acceptedAt: string; actor: string | null; reason: string;
}) {
  return <div className="mt-2 space-y-1 break-all text-xs text-gray-500"><p>{source}</p>
    <p className="font-mono">SHA-256 {digest}</p><p>Valid until {billingDateTime(expiresAt)}</p>
    <p>Accepted {billingDateTime(acceptedAt)} {actor === null ? 'automatically by the renewal job' : `by ${actor}`}</p>
    <p>{reason}</p></div>;
}
