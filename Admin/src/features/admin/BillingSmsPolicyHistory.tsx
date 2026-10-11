import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import type { SmsPolicies, SmsPolicyAlert } from '../../schemas/billing-sms-policies';

type Route = SmsPolicies['routes'][number];
const routeSubject = (route: Route) => `${route.account_sid}:${route.country}:${route.direction}:${route.currency}`;

/** Open renewal-job conditions; each names the route or rate and what a person has to do. */
export function BillingSmsPolicyAlerts({ alerts }: { alerts: SmsPolicyAlert[] }) {
  if (!alerts.length) return null;
  return <Card className="space-y-3 border-amber-200 p-5"><h3 className="font-semibold text-gray-900">Needs attention</h3>
    {alerts.map((alert) => <div key={alert.id} role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
      <p>{alert.message}</p>
      <p className="mt-1 text-xs text-amber-700">Raised {new Date(alert.opened_at).toLocaleString()} by the renewal job</p>
    </div>)}
  </Card>;
}

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
  return <Card className="space-y-4 p-5"><div className="flex items-center justify-between"><h3 className="font-semibold text-gray-900">Accepted evidence history</h3>
    <Button onClick={onReload}>Reload history</Button></div>
    {loading ? <p className="text-sm text-gray-500">Loading accepted policies...</p> : null}
    {failed ? <p role="alert" className="text-sm text-red-600">Could not load accepted policies. Reload history to retry.</p> : null}
    {data ? <>
      <p className="text-xs text-gray-500">Latest 50 currency policies and 100 route policies; immutable acceptance records.</p>
      {data.fx.map((value) => <div key={value.id} className="rounded-lg border border-gray-200 p-3 text-sm">
        <PolicyStatus expiresAt={value.expires_at} attention={attention(value.policy)} /> <strong>ECB · {value.rate_date} · USD/EUR {value.usd_per_eur}</strong>
        <EvidenceRecord source={value.source} digest={value.source_digest} expiresAt={value.expires_at}
          acceptedAt={value.accepted_at} actor={value.accepted_by_user_id} reason={value.acceptance_reason} />
      </div>)}
      {data.routes.map((value) => <div key={value.id} className="rounded-lg border border-gray-200 p-3 text-sm">
        <PolicyStatus expiresAt={value.expires_at} attention={attention(routeSubject(value))} /> <strong>{value.country} · {value.direction} · {value.currency}</strong>
        <p className="mt-1 break-all font-mono text-xs">{value.account_sid} · segment {value.additional_per_segment} · message {value.additional_per_message}</p>
        <p className="mt-1 text-xs text-gray-600">{value.provider_price === null
          ? 'No account price recorded: renews only when a person accepts it again.'
          : `Account price ${value.currency} ${value.provider_price} at acceptance; renews automatically while the price does not rise.`}</p>
        <EvidenceRecord source={value.source} digest={value.evidence_digest} expiresAt={value.expires_at}
          acceptedAt={value.accepted_at} actor={value.accepted_by_user_id} reason={value.acceptance_reason} />
      </div>)}
      {data.fx.length === 0 && data.routes.length === 0 ? <p className="text-sm text-gray-500">No accepted SMS policies.</p> : null}
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
    <p className="font-mono">SHA-256 {digest}</p><p>Valid until {new Date(expiresAt).toLocaleString()}</p>
    <p>Accepted {new Date(acceptedAt).toLocaleString()} {actor === null ? 'automatically by the renewal job' : `by ${actor}`}</p>
    <p>{reason}</p></div>;
}
