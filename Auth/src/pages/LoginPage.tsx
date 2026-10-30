import { useAccessStatusEnabled } from '../utils/access-status.js';
import { AccessStatusForm } from '../components/form/AccessStatusForm.js';
import React, {useState} from 'react';
import { NativeAppConsent } from '../components/form/NativeAppConsent.js';

import { EnterpriseLinkForm } from '../components/form/EnterpriseLinkForm.js';
import { ManagementPersonalFactorForm } from '../components/form/ManagementPersonalFactorForm.js';
import { Button } from '../components/ui/Button.js';
import { useEnterpriseTranslation } from '../i18n/enterprise-actions.js';
import { LoginForm } from '../components/form/LoginForm.js';
import { SocialButtons } from '../components/form/SocialButtons.js';
import { useAccessTranslation } from '../hooks/use-access-translation.js';
import { useTheme } from '../hooks/use-theme.js';
import { usePopup } from '../hooks/use-popup.js';
import { useTranslation } from '../i18n/use-translation.js';
import { isEmailPasswordEnabled } from '../utils/auth-config.js';

export function LoginPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();
  const accessT = useAccessTranslation();
  const { config, notice, clientId, managementOrgId, enterpriseLinkIntent, setView } = usePopup();
  const accessStatusEnabled = useAccessStatusEnabled();
  const showEmailPassword = isEmailPasswordEnabled(config);
  const [personalFactor,setPersonalFactor]=useState(false);
  const enterpriseT=useEnterpriseTranslation();

  if (enterpriseLinkIntent) return <EnterpriseLinkForm intent={enterpriseLinkIntent} />;
  if (managementOrgId&&personalFactor) return <ManagementPersonalFactorForm orgId={managementOrgId}
    onBack={()=>setPersonalFactor(false)}/>;

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{managementOrgId ? accessT('managementTitle') : t('auth.login.title')}</h1>
      {managementOrgId ? <p className="mt-2 text-sm text-[var(--uoa-color-muted)]">
        {accessT('managementHint')}
      </p> : null}
      <NativeAppConsent />
      {notice ? (
        <p
          role="status"
          className="mt-2 rounded-[var(--uoa-radius-input)] bg-[var(--uoa-color-surface)] px-3 py-2 text-sm text-[var(--uoa-color-muted)]"
        >
          {t(notice)}
        </p>
      ) : null}
      {clientId ? <div className="my-6"><SocialButtons showDivider={false} /></div> : null}
      {showEmailPassword ? <LoginForm /> : null}
      {managementOrgId ? <div className="mt-4"><Button variant="secondary" onClick={()=>setPersonalFactor(true)}>
        {enterpriseT('factor')}</Button></div> : null}
      {!clientId ? <div className="mt-6">
        <SocialButtons showDivider={showEmailPassword} />
      </div> : null}
      {accessStatusEnabled ? <AccessStatusForm /> : null}
      {!managementOrgId ? <button type="button" className="mt-5 text-sm underline text-[var(--uoa-color-primary)]"
        onClick={() => setView('account-renewal')}>{t('auth.renewal.open')}</button> : null}
    </div>
  );
}
