import { useEffect, useMemo, useState } from 'react';

import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { FieldShell, TextField } from '../../components/ui/FormFields';
import { Switch } from '../../components/ui/Switch';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { adminService } from '../../services/admin-service';
import { useAdminUi } from '../shell/admin-ui';
import { useDomainSignaturesQuery } from './admin-queries';
import { DomainAgreementManager } from './DomainAgreementManager';
import { DomainSignatureAudit } from './DomainSignatureAudit';
import { DomainSignatureRecords } from './DomainSignatureRecords';

type AgreementsSection = 'agreements' | 'evidence' | 'audit';

export function DomainAgreementsTab({ domain }: { domain: string }) {
  const { confirm } = useAdminUi();
  const overview = useDomainSignaturesQuery(domain);
  const [section, setSection] = useState<AgreementsSection>('agreements');
  const [retentionDays, setRetentionDays] = useState('');
  const [settingsError, setSettingsError] = useState(false);
  const [settingsPending, setSettingsPending] = useState(false);

  useEffect(() => {
    setRetentionDays(overview.data?.settings.retention_days?.toString() ?? '');
  }, [overview.data?.settings.retention_days]);

  const activeRequired = useMemo(() => {
    const now = Date.now();
    return (overview.data?.agreements ?? []).filter(
      (agreement) =>
        agreement.required_for_access &&
        agreement.versions.some(
          (version) =>
            version.status === 'published' &&
            (!version.effective_at || new Date(version.effective_at).getTime() <= now),
        ),
    );
  }, [overview.data?.agreements]);

  if (overview.isLoading) return <p className="text-sm text-gray-400">Loading agreement settings…</p>;
  if (overview.isError || !overview.data) {
    return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">Agreement settings could not be loaded.</p>;
  }

  const { agreements, audit_events: auditEvents, settings } = overview.data;
  const parsedRetention = Number(retentionDays);
  const validRetention = Number.isInteger(parsedRetention) && parsedRetention >= 1 && parsedRetention <= 36_500;
  const canEnable = activeRequired.length > 0 && validRetention;
  const retentionDirty = retentionDays !== (settings.retention_days?.toString() ?? '');

  async function saveSettings(enabled: boolean) {
    setSettingsError(false);
    setSettingsPending(true);
    try {
      await adminService.updateDomainSignatureSettings(
        domain,
        enabled,
        retentionDays ? parsedRetention : null,
      );
      await overview.refetch();
    } catch {
      setSettingsError(true);
    } finally {
      setSettingsPending(false);
    }
  }

  function toggleService() {
    const next = !settings.enabled;
    confirm(
      next ? 'Enable agreement signatures?' : 'Disable agreement signatures?',
      next
        ? 'Users of this domain will have to complete every active required agreement before authorization codes and refreshed access are issued.'
        : 'Authorization will stop enforcing agreements for this domain. Existing agreements, signatures, receipts, revocations, and audit history remain retained.',
      () => saveSettings(next),
    );
  }

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-gray-900">Agreement signature service</h2>
              <Badge variant={settings.enabled ? 'green' : 'slate'}>{settings.enabled ? 'Enabled' : 'Disabled'}</Badge>
            </div>
            <p className="mt-1 max-w-2xl text-xs text-gray-500">
              Optional and isolated to {domain}. When disabled, this domain&apos;s existing authorization and refresh behaviour is unchanged.
            </p>
          </div>
          <Switch
            checked={settings.enabled}
            disabled={settingsPending || (!settings.enabled && !canEnable)}
            label={settings.enabled ? 'Enforcement on' : 'Enforcement off'}
            onClick={toggleService}
          />
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          <Summary label="Policy revision" value={String(settings.policy_revision)} />
          <Summary label="Active required agreements" value={String(activeRequired.length)} />
          <FieldShell label="Evidence retention (days)" hint="Required before the service can be enabled.">
            <div className="flex gap-2">
              <TextField
                min={1}
                max={36500}
                type="number"
                value={retentionDays}
                onChange={(event) => setRetentionDays(event.target.value)}
              />
              <Button
                size="sm"
                disabled={!retentionDirty || settingsPending || (Boolean(retentionDays) && !validRetention)}
                onClick={() => void saveSettings(settings.enabled)}
              >
                Save
              </Button>
            </div>
          </FieldShell>
        </div>
        {!settings.enabled && !canEnable ? (
          <p className="mt-3 text-xs text-amber-700">To enable: set explicit retention and publish at least one currently effective required agreement version. Runtime storage, malware scanning, and evidence keys must also be configured.</p>
        ) : null}
        {settingsError ? (
          <p className="mt-3 text-xs text-red-600">The settings change was rejected. Confirm the active requirement and server-side signature prerequisites.</p>
        ) : null}
      </Card>

      <SegmentedTabs<AgreementsSection>
        value={section}
        onChange={setSection}
        options={[
          { label: 'Agreements', value: 'agreements' },
          { label: 'Signature evidence', value: 'evidence' },
          { label: 'Audit history', value: 'audit' },
        ]}
      />

      {section === 'agreements' ? (
        <DomainAgreementManager
          agreements={agreements}
          domain={domain}
          enabled={settings.enabled}
          refresh={async () => {
            await overview.refetch();
          }}
        />
      ) : null}
      {section === 'evidence' ? <DomainSignatureRecords agreements={agreements} domain={domain} /> : null}
      {section === 'audit' ? <DomainSignatureAudit events={auditEvents} /> : null}
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
      <p className="text-xs text-gray-400">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-gray-900">{value}</p>
    </div>
  );
}
