import { useEffect, useRef, useState } from 'react';
import { LanguageSelector } from '../components/layout/LanguageSelector.js';
import { MachineApprovalList } from '../components/team/MachineApprovalList.js';
import { Button } from '../components/ui/Button.js';
import { Card } from '../components/ui/Card.js';
import { Logo } from '../components/ui/Logo.js';
import { useTheme } from '../hooks/use-theme.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { useMachineTranslation, type MachineText } from '../i18n/machines.js';
import { changeMachinePage, loadMachinePage, machineRecordTime, MachinePageError, signInToMachineHome,
  terminalMachineReasons, type MachinePage } from '../utils/machines.js';

export function MachinesPage() {
  const { classNames } = useTheme(); const t = useMachineTranslation(); const { language } = useI18n();
  const [page, setPage] = useState<MachinePage | null>(null); const [error, setError] = useState<number | null>(null);
  const [busy, setBusy] = useState(false); const pending = useRef(false); const [saveFailed, setSaveFailed] = useState<MachineText | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const sourceConfigUrl = page?.config_url ?? (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('config_url'));
  useEffect(() => {
    let active = true;
    void loadMachinePage().then(value => { if (active) setPage(value); }, cause => {
      if (active) setError(cause instanceof MachinePageError ? cause.status : 0);
    });
    return () => { active = false; };
  }, []);
  async function reload() {
    setError(null);
    try { setPage(await loadMachinePage()); }
    catch (cause) { setError(cause instanceof MachinePageError ? cause.status : 0); }
  }
  async function signInAgain() {
    if (!sourceConfigUrl || pending.current) return;
    pending.current = true; setBusy(true);
    try { await signInToMachineHome(sourceConfigUrl); }
    catch { setError(503); pending.current = false; setBusy(false); }
  }
  async function mutate(change: { approved: boolean } | { revoke: string }) {
    if (!page || pending.current) return;
    pending.current = true; setBusy(true); setSaveFailed(null);
    try { await changeMachinePage(page, change); setPage(await loadMachinePage()); setConfirmation(null); }
    catch (cause) {
      if (cause instanceof MachinePageError && [401, 403].includes(cause.status)) setError(cause.status);
      else if (cause instanceof MachinePageError && cause.code === 'MACHINE_REQUEST_EXPIRED') await reload();
      else setSaveFailed('revoke' in change ? 'revokeFailed' : 'consentFailed');
    } finally { pending.current = false; setBusy(false); }
  }
  const request = page?.request;
  const renewal = request?.reauthorization === true;
  const selected = page?.enrollments.find(row => row.enrollment_id === confirmation);
  const manageableCount = page?.enrollments.filter(row => !terminalMachineReasons.includes(row.reason)).length ?? 0;
  const expired = error !== null && [401, 403].includes(error);
  return <div className={classNames.appShell}><main className={classNames.pageContainer}>
    <div className={classNames.logoWrap}><Logo /></div><LanguageSelector />
    <Card><div className="flex flex-col gap-5">
      <h1 className={classNames.title}>{request?.status === 'pending' ?
        t(renewal ? 'renewTitle' : 'consentTitle', { device: request.device_name }) : t('title')}</h1>
      {error !== null ? <div className="flex flex-col gap-3" role="alert">
        <p>{t(expired ? sourceConfigUrl ? 'expired' : 'expiredWithoutSource' : 'unavailable')}</p>
        {expired ? sourceConfigUrl ? <Button disabled={busy} onClick={() => void signInAgain()}>{t('signInAgain')}</Button> : null :
          <Button onClick={() => void reload()}>{t('retry')}</Button>}
      </div> : !page ? <p role="status">{t('loading')}</p> : <>
        <div className="text-sm text-[var(--uoa-color-muted)]">
          <p>{t('destination', { organization: page.organization_name, team: page.team_name })}</p>
          <p>{t('product', { product: page.client_domain })}</p>
        </div>
        {request?.status === 'pending' ? <section className="flex flex-col gap-4">
          <p>{t(renewal ? 'renewBody' : 'consentBody', { team: page.team_name })}</p>
          {request.legacy_adoption ? <p>{t('adoption')}</p> : null}
          <p className="text-sm">{t('scope')}</p><p className="text-sm">{t('duration')}</p>
          <p className="text-sm text-[var(--uoa-color-muted)]">{t('security')}</p>
          <Button disabled={busy} onClick={() => void mutate({ approved: true })}>{t(renewal ? 'renewApprove' : 'approve')}</Button>
          <Button disabled={busy} variant="secondary" onClick={() => void mutate({ approved: false })}>{t(renewal ? 'renewDecline' : 'decline')}</Button>
        </section> : request ? <section role="status" className="flex flex-col gap-2">
          <h2 className="font-semibold">{t(request.status === 'authorized' ? 'authorized' : request.status === 'expired' ? 'requestExpired' : 'declined')}</h2>
          <p>{t(request.status === 'authorized' ? 'authorizedBody' : request.status === 'expired' ? 'requestExpiredBody' : 'declinedBody', { product: page.client_domain })}</p>
        </section> : null}
        {confirmation ? <section className="flex flex-col gap-3 rounded-lg border border-[var(--uoa-color-border)] p-4" aria-live="polite">
          <h2 className="break-words font-semibold">{t(confirmation === 'all' ? page.truncated ? 'confirmAllUnbounded' : 'confirmAll' : 'confirmTitle', {
            device: selected?.device_name ?? '', team: page.team_name, count: String(manageableCount),
          })}</h2>
          {selected ? <><p className="text-sm">{t('recordCreated', { time: machineRecordTime(selected.created_at, language) })}</p>
            <p className="break-all text-xs">{t('approvalReference', { reference: selected.enrollment_id })}</p></> : null}
          <p className="text-sm">{t('confirmBody')}</p>
          <Button variant="danger" disabled={busy} onClick={() => void mutate({ revoke: confirmation })}>{t(confirmation === 'all' ? 'confirmAllAction' : 'confirm')}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => { setConfirmation(null); setSaveFailed(null); }}>{t('cancel')}</Button>
        </section> : <MachineApprovalList page={page} busy={busy} hideEmpty={request?.status === 'pending'}
          onRevoke={id => { setConfirmation(id); setSaveFailed(null); }} />}
        {saveFailed ? <p role="alert" className="text-sm text-[var(--uoa-color-danger)]">{t(saveFailed)}</p> : null}
      </>}
    </div></Card>
  </main></div>;
}
