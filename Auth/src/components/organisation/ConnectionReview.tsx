import { useState } from 'react';
import { useAccessTranslation } from '../../hooks/use-access-translation.js';
import { accessMutation, trustedTestUrl, type AccessSettings, type Connection } from '../../utils/organisation-access.js';
import { AccessProvisioning } from './AccessProvisioning.js';
import { ConnectionMaintenance } from './ConnectionMaintenance.js';
import { Button } from '../ui/Button.js';
import { CopyValue } from './CopyValue.js';
import type { AccessKey } from '../../i18n/organisation-access.js';

const blockers: Record<string, AccessKey> = {
  ASSURANCE_CONTRACT_REQUIRED: 'assurance', NESSIE_AUTHORITY_MIGRATION_REQUIRED: 'migration',
  REVOCATION_CONSUMERS_REQUIRED: 'revocation', RECOVERY_SETUP_REQUIRED: 'recovery',
  CONNECTION_TEST_REQUIRED: 'testNeeded', RECOVERY_DRILL_REQUIRED: 'recovery',
  CUSTOM_ARRANGEMENT_REQUIRED: 'customArrangement', LIVE_IDENTITY_FLOW_REQUIRED: 'liveSignIn',
};
export function ConnectionReview(props: {
  settings: AccessSettings; connection: Connection; busy: boolean;
  onEdit: () => void; onError: () => void;
  onRecovery: () => void;
  mutate: (method: 'POST' | 'DELETE', path: string, body?: unknown) => Promise<Record<string, unknown> | undefined>;
}) {
  const t = useAccessTranslation();
  const c = props.connection;
  const [testing, setTesting] = useState(false);
  const tested = c.tested_revision === c.revision;
  const configured = Object.keys(c.configuration).length > 0;
  const lastTest = c.last_test?.status;
  const path = `/connections/${encodeURIComponent(c.id)}`;
  async function test() {
    setTesting(true);
    try {
      const result = await accessMutation(props.settings, 'POST', `${path}/test`, { revision: c.revision });
      window.location.assign(trustedTestUrl(result.test_url));
    } catch { props.onError(); setTesting(false); }
  }
  return <section className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-semibold">{c.display_name}</h2>
        <p className="text-sm text-[var(--uoa-color-muted)]">{t(!configured ? 'setupIncomplete' : c.status === 'active' ? 'active' : c.status === 'suspended' ? 'suspended' : tested ? 'passedStatus' : 'saved')}</p></div>
      <Button className="w-auto!" variant="secondary" disabled={props.busy} onClick={props.onEdit}>{t(configured ? 'edit' : 'continueSetup')}</Button>
    </div>
    <div className="space-y-3"><p>{t('providerInstructions')}</p>
      {c.protocol === 'oidc' && c.callback_url && <CopyValue label={t('callback')} value={c.callback_url} />}
      {c.protocol === 'saml' && <>
        {c.acs_url && <CopyValue label={t('callback')} value={c.acs_url} />}
        {c.sp_entity_id && <CopyValue label={t('sp')} value={c.sp_entity_id} />}
      </>}
    </div>
    <div className="space-y-3 border-t border-[var(--uoa-color-border)] pt-5">
      <h3 className="font-semibold">{t('test')}</h3>
      <p role="status">{t(!configured ? 'finishSetup' : tested ? 'testPassed' : lastTest === 'failed' ? 'testFailed' : 'testIntro')}</p>
      {configured && <Button disabled={props.busy || testing} onClick={() => void test()}>{t(tested ? 'testAgain' : 'test')}</Button>}
    </div>
    <div className="space-y-3 border-t border-[var(--uoa-color-border)] pt-5">
      <h3 className="font-semibold">{t('enable')}</h3>
      <p>{t(props.settings.readiness.activation_allowed && tested ? 'ready' : tested ? 'blockedPassed' : 'blocked')}</p>
      {!tested && <p>{t('testNeeded')}</p>}
      {props.settings.readiness.blockers.some(code => ['RECOVERY_SETUP_REQUIRED', 'RECOVERY_DRILL_REQUIRED'].includes(code)) && <Button variant="secondary" onClick={props.onRecovery}>{t('recoveryTitle')}</Button>}
      {props.settings.readiness.blockers.length > 0 && <details><summary className="min-h-11 cursor-pointer text-sm">{t('readinessDetails')}</summary><ul className="list-disc space-y-2 pl-5 text-sm">
        {[...new Set(props.settings.readiness.blockers.map((code) => blockers[code] ?? 'unknownBlocker'))].map((key) => <li key={key}>{t(key)}</li>)}
      </ul></details>}
      {(c.status === 'active' || (props.settings.readiness.activation_allowed && tested)) && <Button disabled={props.busy}
        onClick={() => void props.mutate('POST', `${path}/state`, { revision: c.revision, status: c.status === 'active' ? 'disabled' : 'active' })}>
        {t(c.status === 'active' ? 'disable' : 'enable')}
      </Button>}
    </div>
    <ConnectionMaintenance connection={c} busy={props.busy} mutate={props.mutate} />
    <AccessProvisioning settings={props.settings} connection={c} />
  </section>;
}
