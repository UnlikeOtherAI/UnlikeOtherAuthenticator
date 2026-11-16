import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { FieldShell, TextField } from '../../components/ui/FormFields';
import type { BillingService } from '../../schemas/billing';
import { useBillingPeriodSettings, useSaveBillingPeriodSettings } from './billing-period-settings-queries';
import { billingDateTime } from './billing-format';

const whole = (value: string, max: number): number | null => {
  const parsed = Number(value.trim());
  return /^\d+$/.test(value.trim()) && parsed >= 1 && parsed <= max ? parsed : null;
};

export function BillingPeriodsPanel({ service }: { service: BillingService }) {
  const settings = useBillingPeriodSettings(service.id),
    save = useSaveBillingPeriodSettings(service.id);
  // Null until edited, so the saved value shows without copying it into state.
  const [trialDays, setTrialDays] = useState<string | null>(null),
    [graceHours, setGraceHours] = useState<string | null>(null),
    [error, setError] = useState('');
  const saved = settings.data;
  const trialValue = trialDays ?? (saved ? String(saved.seat_trial_hours / 24) : ''),
    graceValue = graceHours ?? (saved ? String(saved.seat_renewal_grace_hours) : '');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const days = whole(trialValue, 365),
      hours = whole(graceValue, 720);
    if (days === null || hours === null) {
      setError('Enter whole numbers: 1–365 days for the trial and 1–720 hours for the grace period.');
      return;
    }
    try {
      await save.mutateAsync({ seat_trial_hours: days * 24, seat_renewal_grace_hours: hours });
      setTrialDays(null);
      setGraceHours(null);
    } catch {
      setError('The periods could not be saved. Reload and try again.');
    }
  };
  return (
    <div className="space-y-5 p-5">
      <p className="max-w-2xl text-sm text-gray-600">
        A change applies to trials and grace periods that start after you save. One that is already running
        keeps the deadline its organisation was shown.
      </p>
      {settings.isLoading ? <p>Loading time periods...</p> : null}
      {settings.isError ? (
        <p role="alert">
          Could not load the time periods. <Button onClick={() => void settings.refetch()}>Retry</Button>
        </p>
      ) : null}
      {saved ? (
        <form onSubmit={(event) => void submit(event)} className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <FieldShell
            label="Free trial (days)"
            hint="Free seats for a new organisation's first person, or for the current members of one moving to a paid plan."
          >
            <TextField
              required
              inputMode="numeric"
              value={trialValue}
              onChange={(event) => setTrialDays(event.target.value)}
            />
          </FieldShell>
          <FieldShell
            label="Grace after a failed seat renewal (hours)"
            hint="Counted Monday to Friday only. Access is held when it ends unpaid."
          >
            <TextField
              required
              inputMode="numeric"
              value={graceValue}
              onChange={(event) => setGraceHours(event.target.value)}
            />
          </FieldShell>
          <p className="text-sm text-gray-500 sm:col-span-2">
            {saved.updated_at
              ? `Last changed ${billingDateTime(saved.updated_at)}.`
              : 'These are the defaults; nobody has changed them.'}
          </p>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending ? 'Saving...' : 'Save time periods'}
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-red-600 sm:col-span-2">
              {error}
            </p>
          ) : null}
          {save.isSuccess && !error ? (
            <p role="status" className="text-sm text-green-700">
              Time periods saved.
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
