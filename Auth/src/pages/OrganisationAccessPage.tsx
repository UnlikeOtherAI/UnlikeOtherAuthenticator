import { useEffect, useState } from 'react';
import { AccessPolicy } from '../components/organisation/AccessPolicy.js';
import { useEnterpriseTranslation } from '../i18n/enterprise-actions.js';
import { record, text } from '../utils/enterprise-response.js';
import { AccessRecovery } from '../components/organisation/AccessRecovery.js';
import { AccessDomains } from '../components/organisation/AccessDomains.js';
import { ConnectionForm, providerNames, type ConnectionDraft } from '../components/organisation/ConnectionForm.js';
import { ConnectionReview } from '../components/organisation/ConnectionReview.js';
import { LanguageSelector } from '../components/layout/LanguageSelector.js';
import { Button } from '../components/ui/Button.js';
import { Card } from '../components/ui/Card.js';
import { Logo } from '../components/ui/Logo.js';
import { useAccessTranslation } from '../hooks/use-access-translation.js';
import { useTheme } from '../hooks/use-theme.js';
import { AccessError, accessMutation, loadOrganisationAccess, openOrganisationAccess,
  type AccessSettings } from '../utils/organisation-access.js';

type View = 'overview' | 'choose' | 'connect' | 'review' | 'domains' | 'recovery' | 'policy';
export function OrganisationAccessPage() {
  const { classNames } = useTheme();
  const t = useAccessTranslation(); const enterpriseT = useEnterpriseTranslation();
  const [settings, setSettings] = useState<AccessSettings | null>(null);
  const [error, setError] = useState<number | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>('overview');
  const [selection, setSelection] = useState({ preset: '', protocol: 'oidc' as 'oidc' | 'saml' });
  const [connectionId, setConnectionId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void openOrganisationAccess().then((data) => {
      if (!active) return;
      setSettings(data);
      const testId = new URLSearchParams(window.location.search).get('test');
      if (testId) {
        const tested = data.connections.find((c) => c.id === testId);
        if (tested) { setConnectionId(tested.id); setView('review'); }
        window.history.replaceState(null, '', window.location.pathname);
      }
    }, (cause: unknown) => { if (active) setError(cause instanceof AccessError ? cause.status : 0); });
    return () => { active = false; };
  }, []);

  async function reload() {
    setError(null);
    try { setSettings(await openOrganisationAccess()); }
    catch (cause) { setError(cause instanceof AccessError ? cause.status : 0); }
  }
  async function mutate(method: 'POST' | 'DELETE', path: string, body?: unknown) {
    if (!settings) return;
    setBusy(true); setSaveError(false);
    try {
      const result = await accessMutation(settings, method, path, body);
      setSettings(await loadOrganisationAccess());
      return result;
    }
    catch { setSaveError(true); }
    finally { setBusy(false); }
  }
  async function save(draft: ConnectionDraft) {
    if (!settings) return false;
    setBusy(true); setSaveError(false);
    try {
      const result = await accessMutation(settings, connectionId ? 'PATCH' : 'POST',
        '/connections' + (connectionId ? `/${encodeURIComponent(connectionId)}` : ''), draft);
      const fresh = await loadOrganisationAccess(); setSettings(fresh);
      const saved = result.connection;
      if (!saved || typeof saved !== 'object' || !('id' in saved) || typeof saved.id !== 'string') throw new Error('Invalid connection');
      setConnectionId(saved.id); setView('review');
      return true;
    } catch { setSaveError(true); return false; }
    finally { setBusy(false); }
  }
  function navigate(next: View) { setSaveError(false); setView(next); }
  async function reserve(preset: string, protocol: 'oidc' | 'saml') {
    if (!settings) return;
    setBusy(true); setSaveError(false);
    try {
      const result = await accessMutation(settings, 'POST', '/connections', {
        preset, protocol, display_name: providerNames[preset] ?? preset, configuration: {},
      });
      const fresh = await loadOrganisationAccess();
      const created = result.connection;
      if (!created || typeof created !== 'object' || !('id' in created) || typeof created.id !== 'string') throw new Error('Invalid connection');
      setSettings(fresh); setConnectionId(created.id); setSelection({ preset, protocol }); navigate('connect');
    } catch { setSaveError(true); }
    finally { setBusy(false); }
  }
  const connection = settings?.connections.find((c) => c.id === connectionId);
  const presets = settings?.presets ?? [];
  const currentStep = view === 'review'
    ? connection && connection.tested_revision === connection.revision ? 'enable' : 'test'
    : view;

  return <div className={classNames.appShell}>
    <main className={classNames.pageContainer.replace('max-w-lg', 'max-w-3xl')}>
      <div className={classNames.logoWrap}><Logo /></div><LanguageSelector />
      <Card><div className="space-y-6">
        <header className="space-y-3 border-b border-[var(--uoa-color-border)] pb-5">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          {settings && <p className="break-words text-sm text-[var(--uoa-color-muted)]">{t('destination', { org: settings.org.name, domain: settings.client_domain })}</p>}
        </header>
        {error !== null ? <div className="space-y-4" role="alert"><p>{t([401, 403, 410].includes(error) ? 'expired' : 'error')}</p>
          {![401, 403, 410].includes(error) && <Button onClick={() => void reload()}>{t('retry')}</Button>}
        </div> : !settings ? <p role="status">{t('loading')}</p> : <>
          {saveError && <p role="alert" className="text-[var(--uoa-color-danger)]">{t('saveError')}</p>}
          {view !== 'overview' && view !== 'connect' && <Button className="w-auto!" variant="secondary" onClick={() => navigate('overview')} disabled={busy}>{t('back')}</Button>}
          {['choose', 'connect', 'review'].includes(view) && <ol className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-[var(--uoa-color-muted)]">
            {(['choose', 'connect', 'test', 'enable'] as const).map((step, index) => <li key={step}
              className={currentStep === step ? 'font-semibold text-[var(--uoa-color-text)]' : undefined}
              aria-current={currentStep === step ? 'step' : undefined}>
              {index + 1}. {t(step)}
            </li>)}
          </ol>}
          {view === 'overview' && <>
            <p>{t('intro')}</p>
            {settings.connections.length === 0 ? <Button onClick={() => navigate('choose')}>{t('choose')}</Button> : <>
              <div className="divide-y divide-[var(--uoa-color-border)]">
                {settings.connections.map((c) => <button key={c.id} type="button"
                  className="flex min-h-16 w-full items-center justify-between gap-4 py-4 text-left"
                  onClick={() => { setConnectionId(c.id); navigate('review'); }}>
                  <span><span className="block font-medium">{c.display_name}</span>
                    <span className="text-sm text-[var(--uoa-color-muted)]">{t(Object.keys(c.configuration).length === 0 ? 'setupIncomplete' : c.status === 'active' ? 'active' : c.status === 'suspended' ? 'suspended' : c.tested_revision === c.revision ? 'passedStatus' : 'saved')}</span></span>
                  <span aria-hidden="true">›</span>
                </button>)}
              </div><Button variant="secondary" onClick={() => navigate('choose')}>{t('newConnection')}</Button>
            </>}
            <nav aria-label={t('settings')} className="flex flex-col items-start gap-2 border-t border-[var(--uoa-color-border)] pt-5">
              <Button variant="secondary" onClick={() => navigate('policy')}>{enterpriseT('accessPolicy')}</Button>
              <Button variant="secondary" onClick={() => navigate('domains')}>{t('domains')}</Button>
              <Button variant="secondary" onClick={() => navigate('recovery')}>{t('recoveryTitle')}</Button>
            </nav>
          </>}
          {view === 'choose' && <section className="space-y-4"><h2 className="text-xl font-semibold">{t('choose')}</h2>
            <div className="grid gap-3 sm:grid-cols-2">{presets.map((preset) => <Button key={preset.id} variant="secondary"
              disabled={busy} onClick={() => void reserve(preset.id, preset.protocols.includes('oidc') ? 'oidc' : 'saml')}>
              {providerNames[preset.id] ?? preset.id}
            </Button>)}</div>
          </section>}
          {view === 'connect' && <ConnectionForm key={connectionId ?? selection.preset} {...selection}
            parseMetadata={async (xml) => {
              if (!connectionId) throw new Error('A saved draft is required');
              const result = await accessMutation(settings, 'POST', `/connections/${encodeURIComponent(connectionId)}/metadata/parse`, { xml });
              const value = record(result.configuration);
              if (!Array.isArray(value.certificates) || value.certificates.length < 1 || value.certificates.length > 3) throw new Error('Invalid metadata response');
              return { entity_id: text(value.entity_id), sso_url: text(value.sso_url), certificate: value.certificates.map(text).join('\n') };
            }}
            existing={connection} busy={busy} onSave={save} onBack={() => navigate(connection ? 'review' : 'choose')} />}
          {view === 'review' && connection && <ConnectionReview settings={settings} connection={connection} busy={busy}
            onRecovery={() => navigate('recovery')}
            onError={() => setSaveError(true)} mutate={mutate}
            onEdit={() => { setSelection({ preset: connection.preset, protocol: connection.protocol }); navigate('connect'); }} />}
          {view === 'domains' && <AccessDomains settings={settings} busy={busy} mutate={mutate} />}
          {view === 'policy' && <AccessPolicy settings={settings} onConnect={() => navigate('choose')} onSaved={async () => { setSettings(await loadOrganisationAccess()); }} />}
          {view === 'recovery' && <AccessRecovery settings={settings} />}
        </>}
      </div></Card>
    </main>
  </div>;
}
