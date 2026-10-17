import { useState } from 'react';
import { useAccessTranslation } from '../../hooks/use-access-translation.js';
import type { Connection } from '../../utils/organisation-access.js';
import { Button } from '../ui/Button.js';
import { Input, fieldInputClassName } from '../ui/Input.js';
import { CopyValue } from './CopyValue.js';

export const providerNames: Record<string, string> = {
  entra: 'Microsoft Entra ID', entra_id: 'Microsoft Entra ID', okta: 'Okta',
  google_workspace: 'Google Workspace', keycloak: 'Keycloak', adfs: 'AD FS',
  other_oidc: 'Other OIDC', other_saml: 'Other SAML',
};
export type ConnectionDraft = {
  preset: string; protocol: 'oidc' | 'saml'; display_name: string;
  configuration: Record<string, unknown>; secret?: string; revision?: number;
};

export function ConnectionForm(props: {
  preset: string; protocol: 'oidc' | 'saml'; existing?: Connection;
  busy: boolean; onSave: (draft: ConnectionDraft) => Promise<void>; onBack: () => void;
}) {
  const t = useAccessTranslation();
  const original = props.existing?.configuration ?? {};
  const tenant = original.tenant as Record<string, string> | undefined;
  const [fields, setFields] = useState<Record<string, string>>({
    name: props.existing?.display_name ?? providerNames[props.preset] ?? props.preset,
    issuer: String(original.issuer ?? ''), client_id: String(original.client_id ?? ''),
    tenant: tenant?.value ?? '', tenant_claim: tenant?.claim ?? tenant?.attribute ?? '',
    authorization_endpoint: String(original.authorization_endpoint ?? ''),
    token_endpoint: String(original.token_endpoint ?? ''), jwks_uri: String(original.jwks_uri ?? ''),
    entity_id: String(original.entity_id ?? ''), sso_url: String(original.sso_url ?? ''),
    subject_attribute: String(original.subject_attribute ?? ''),
    certificate: Array.isArray(original.certificates) ? original.certificates.join('\n') : '', secret: '',
  });
  const [invalid, setInvalid] = useState(false);
  const entra = ['entra', 'entra_id'].includes(props.preset);
  const google = props.preset === 'google_workspace';
  const oidc = props.protocol === 'oidc';
  const helpUrl = entra ? 'https://entra.microsoft.com/' : google ? 'https://console.cloud.google.com/apis/credentials'
    : props.preset === 'okta' ? 'https://developer.okta.com/docs/guides/sign-into-web-app-redirect/'
      : props.preset === 'keycloak' ? 'https://www.keycloak.org/securing-apps/oidc-layers' : null;
  const input = (key: string, label: string, type = 'text', required = true) => <Input
    key={key} label={label} type={type} required={required} value={fields[key] ?? ''}
    autoComplete={key === 'secret' ? 'new-password' : 'off'}
    onChange={(event) => setFields({ ...fields, [key]: event.target.value })} />;

  async function submit() {
    let configuration: Record<string, unknown>;
    if (oidc) {
      const issuer = entra ? `https://login.microsoftonline.com/${fields.tenant}/v2.0`
        : google ? 'https://accounts.google.com' : fields.issuer;
      const base = entra ? `https://login.microsoftonline.com/${fields.tenant}/oauth2/v2.0` : '';
      configuration = { issuer, client_id: fields.client_id,
        authorization_endpoint: entra ? `${base}/authorize` : google ? 'https://accounts.google.com/o/oauth2/v2/auth' : fields.authorization_endpoint,
        token_endpoint: entra ? `${base}/token` : google ? 'https://oauth2.googleapis.com/token' : fields.token_endpoint,
        jwks_uri: entra ? `https://login.microsoftonline.com/${fields.tenant}/discovery/v2.0/keys`
          : google ? 'https://www.googleapis.com/oauth2/v3/certs' : fields.jwks_uri,
        tenant: { claim: entra ? 'tid' : google ? 'hd' : fields.tenant_claim, value: fields.tenant },
        subject_claim: entra ? 'oid' : 'sub',
        ...(google ? { hosted_domains: [fields.tenant] } : {}),
      };
      configuration.trusted_origins = [...new Set([issuer, configuration.authorization_endpoint,
        configuration.token_endpoint, configuration.jwks_uri].map((url) => new URL(String(url)).origin))];
    } else {
      configuration = { entity_id: fields.entity_id, sso_url: fields.sso_url,
        certificates: [fields.certificate], subject_attribute: fields.subject_attribute,
        tenant: { attribute: fields.tenant_claim, value: fields.tenant },
        trusted_origins: [new URL(fields.sso_url ?? '').origin],
      };
    }
    await props.onSave({ preset: props.preset, protocol: props.protocol,
      display_name: fields.name ?? '', configuration,
      ...(fields.secret ? { secret: fields.secret } : {}),
      ...(props.existing ? { revision: props.existing.revision } : {}),
    });
    setFields((current) => ({ ...current, secret: '' }));
  }

  return <form className="space-y-5" onSubmit={(event) => {
    event.preventDefault(); setInvalid(false);
    void submit().catch(() => setInvalid(true));
  }}>
    <h2 className="text-xl font-semibold">{t('connect')} · {providerNames[props.preset] ?? props.preset}</h2>
    <p className="text-sm text-[var(--uoa-color-muted)]">{t(entra ? 'entraHelp' : google ? 'googleHelp' : oidc ? 'oidcHelp' : 'samlHelp')}</p>
    {helpUrl && <a href={helpUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-[var(--uoa-color-primary)] underline">{t('providerHelp')}</a>}
    {props.existing && <div className="space-y-3">
      <p className="text-sm">{t('providerInstructions')}</p>
      {oidc && props.existing.callback_url && <CopyValue label={t('callback')} value={props.existing.callback_url} />}
      {!oidc && <>
        {props.existing.acs_url && <CopyValue label={t('callback')} value={props.existing.acs_url} />}
        {props.existing.sp_entity_id && <CopyValue label={t('sp')} value={props.existing.sp_entity_id} />}
      </>}
    </div>}
    {invalid && <p role="alert">{t('saveError')}</p>}
    {input('name', t('name'))}
    {oidc ? <>
      {(entra || google) ? input('tenant', t(entra ? 'tenant' : 'hostedDomain')) : input('issuer', t('issuer'), 'url')}
      {input('client_id', t('clientId'))}
      {input('secret', t('secret'), 'password', !props.existing?.secret_configured)}
      {props.existing?.secret_configured && <p className="text-sm text-[var(--uoa-color-muted)]">{t('secretSaved')}</p>}
      {!entra && !google && <details open className="space-y-4">
        <summary className="min-h-11 cursor-pointer font-medium">{t('details')}</summary>
        {input('authorization_endpoint', t('authorizeUrl'), 'url')}
        {input('token_endpoint', t('tokenUrl'), 'url')}{input('jwks_uri', t('keysUrl'), 'url')}
        {input('tenant_claim', t('tenantClaim'))}{input('tenant', t('tenantValue'))}
      </details>}
    </> : <>
      {input('entity_id', t('entityId'))}{input('sso_url', t('signInUrl'), 'url')}
      <label className="block text-sm font-medium">{t('certificate')}
        <textarea required rows={5} className={fieldInputClassName('font-mono text-xs')}
          value={fields.certificate} onChange={(event) => setFields({ ...fields, certificate: event.target.value })} />
      </label>
      <details open className="space-y-4"><summary className="min-h-11 cursor-pointer font-medium">{t('details')}</summary>
        {input('subject_attribute', t('subjectAttribute'))}
        {input('tenant_claim', t('tenantAttribute'))}{input('tenant', t('tenantValue'))}
      </details>
    </>}
    <div className="flex flex-wrap gap-3">
      <Button type="button" variant="secondary" onClick={props.onBack} disabled={props.busy}>{t('back')}</Button>
      <Button type="submit" disabled={props.busy}>{t('save')}</Button>
    </div>
  </form>;
}
