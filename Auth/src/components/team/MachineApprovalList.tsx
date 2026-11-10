import { Button } from '../ui/Button.js';
import { useI18n } from '../../i18n/I18nProvider.js';
import { useMachineTranslation, type MachineText } from '../../i18n/machines.js';
import { machineRecordTime, terminalMachineReasons, type MachinePage } from '../../utils/machines.js';

const reasonText: Record<string, MachineText> = {
  authorization_expired: 'renewalNeeded', inactive: 'renewalNeeded', credential_expired: 'renewalNeeded',
  security_reset: 'securityReset', device_revoked: 'retired', all_devices_revoked: 'retired',
  credential_replay: 'retired', lineage_invalid: 'retired', access_removed: 'scopeRemoved',
  sso_policy_changed: 'policyChanged', authentication_policy_changed: 'policyChanged',
  account_unavailable: 'productStopped', product_disabled: 'productStopped',
};
export function MachineApprovalList(props: { page: MachinePage; busy: boolean; hideEmpty: boolean; onRevoke: (id: string) => void }) {
  const t = useMachineTranslation(); const { language } = useI18n();
  const current = props.page.enrollments.filter(row => !terminalMachineReasons.includes(row.reason));
  const history = props.page.enrollments.filter(row => terminalMachineReasons.includes(row.reason));
  function rows(items: MachinePage['enrollments'], ended: boolean) {
    return items.map(row => <div key={row.enrollment_id} className="flex flex-col gap-2 border-t border-[var(--uoa-color-border)] pt-4">
      <p className="break-words font-medium">{row.device_name}</p>
      <p className="text-sm text-[var(--uoa-color-muted)]">{t('recordCreated', { time: machineRecordTime(row.created_at, language) })}</p>
      <p className="break-all text-xs text-[var(--uoa-color-muted)]">{t('approvalReference', { reference: row.enrollment_id })}</p>
      <p className="text-sm">{t(ended ? 'revoked' : row.decision === 'allowed' ? 'active' : row.decision === 'revoked' ? 'stopped' :
        row.decision === 'access_removed' ? 'removed' : 'held')}</p>
      {reasonText[row.reason] ? <p className="text-sm text-[var(--uoa-color-muted)]">{t(reasonText[row.reason])}</p> : null}
      {!ended ? <Button variant="secondary" disabled={props.busy} onClick={() => props.onRevoke(row.enrollment_id)}>{t('revoke')}</Button> : null}
    </div>);
  }
  return <div className="flex flex-col gap-5">
    {!props.hideEmpty && props.page.enrollments.length === 0 ? <p className="text-sm text-[var(--uoa-color-muted)]">
      {t('empty', { product: props.page.client_domain })}</p> : null}
    {current.length ? <section className="flex flex-col gap-4" aria-label={t('currentApprovals')}>
      <h2 className="font-semibold">{t('currentApprovals')}</h2>{rows(current, false)}
    </section> : null}
    {current.length ? <section className="flex flex-col gap-3 border-t border-[var(--uoa-color-border)] pt-4">
      <h2 className="font-semibold">{t('bulkLabel', { team: props.page.team_name, product: props.page.client_domain })}</h2>
      <Button variant="secondary" disabled={props.busy} onClick={() => props.onRevoke('all')}>{t('revokeAll')}</Button>
    </section> : null}
    {history.length ? <section className="flex flex-col gap-4" aria-label={t('endedApprovals')}>
      <h2 className="font-semibold">{t('endedApprovals')}</h2>{rows(history, true)}
    </section> : null}
    {props.page.truncated ? <p className="text-sm">{t('bounded')}</p> : null}
  </div>;
}
