import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/Button';
import { FieldShell, TextField } from '../../components/ui/FormFields';
import type { BillingService } from '../../schemas/billing';
import { useBrowserPolicies, usePublishBrowserPolicy } from './billing-browser-policy-queries';
import { useBillingNavigation } from './billing-navigation';

export function BillingBrowserPolicyPanel({ service }: { service: BillingService }) {
  const { href } = useBillingNavigation();
  const list = useBrowserPolicies(service.id),
    publish = usePublishBrowserPolicy(service.id);
  const [project, setProject] = useState(''),
    [rate, setRate] = useState(''),
    [source, setSource] = useState('');
  const [until, setUntil] = useState(''),
    [error, setError] = useState('');
  const active = list.data?.policies.find((row) => row.project_id === project.trim() && !row.retired_at);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      await publish.mutateAsync({
        project_id: project.trim(),
        provider_price_per_hour: rate.trim(),
        source_url: source.trim(),
        rounding_seconds: 60,
        valid_until: new Date(until).toISOString(),
        expected_policy_id: active?.policy_id ?? null,
      });
    } catch {
      setError(
        'The tariff could not be published. Check the values and reload if another operator changed it.',
      );
    }
  };
  return (
    <div className="space-y-5 p-5">
      <div className="max-w-2xl space-y-2 text-sm text-gray-600">
        <p>
          Browser sessions use prepaid credits at the provider rate plus 10%, with a one-minute minimum. The
          session keeps its rate and original payer until settlement.
        </p>
        <p>
          This tariff covers browser time. Nessie absorbs the fixed provider subscription fee. Proxy traffic
          is disabled. An expired tariff blocks new sessions.
        </p>
      </div>
      {list.isLoading ? <p>Loading browser tariffs...</p> : null}
      {list.isError ? (
        <p role="alert">
          Could not load browser tariffs. <Button onClick={() => void list.refetch()}>Retry</Button>
        </p>
      ) : null}
      {list.data?.reconciliation ? (
        <p className="text-sm text-gray-600">
          <Link
            className="text-blue-600 underline"
            to={href({ section: 'exceptions', product: null, tab: null })}
          >
            Review usage exceptions
          </Link>
          . Customer charges remain capped at their original reservation.
        </p>
      ) : null}
      {list.data ? (
        <div className="space-y-2 text-sm">
          <p>
            {list.data.pending} sessions awaiting settlement · {list.data.reconciliation} need reconciliation
          </p>
          {list.data.policies
            .filter((row) => !row.retired_at)
            .map((row) => (
              <div key={row.policy_id} className="rounded-lg border border-gray-200 p-3">
                <p className="font-medium">Project {row.project_id}</p>
                <p>
                  ${row.provider_price_per_hour}/hour provider cost · $
                  {Number(row.customer_price_per_minute).toFixed(6)}/minute customer rate
                </p>
                <p>
                  Valid until {new Date(row.valid_until).toLocaleString()} · Started minute, one-minute
                  minimum
                </p>
                <a className="text-blue-600 underline" href={row.source_url} target="_blank" rel="noreferrer">
                  Provider price evidence
                </a>
              </div>
            ))}
        </div>
      ) : null}
      <form onSubmit={(event) => void save(event)} className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <FieldShell label="Browserbase project ID">
          <TextField required value={project} onChange={(event) => setProject(event.target.value)} />
        </FieldShell>
        <FieldShell label="Provider cost per hour (USD)">
          <TextField
            required
            inputMode="decimal"
            value={rate}
            onChange={(event) => setRate(event.target.value)}
          />
        </FieldShell>
        <FieldShell label="Valid until" hint="Up to 90 days; review the provider price before renewal.">
          <TextField
            required
            type="datetime-local"
            value={until}
            onChange={(event) => setUntil(event.target.value)}
          />
        </FieldShell>
        <div className="sm:col-span-2">
          <FieldShell label="Browserbase price evidence URL">
            <TextField
              required
              type="url"
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
          </FieldShell>
        </div>
        <p className="text-sm text-gray-500 sm:col-span-2">
          Markup is fixed at 10%. Publishing a new version affects new sessions only.
        </p>
        <Button
          type="submit"
          variant="primary"
          disabled={publish.isPending || list.isLoading || list.isError}
        >
          {publish.isPending ? 'Publishing...' : 'Publish browser tariff'}
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-red-600 sm:col-span-2">
            {error}
          </p>
        ) : null}
        {publish.isSuccess && !error ? (
          <p role="status" className="text-sm text-green-700">
            Browser tariff published.
          </p>
        ) : null}
      </form>
    </div>
  );
}
