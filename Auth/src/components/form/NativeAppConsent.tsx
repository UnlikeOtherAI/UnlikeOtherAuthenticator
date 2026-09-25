import { usePopup } from '../../hooks/use-popup.js';

export function NativeAppConsent() {
  const { clientId, scope, redirectUrl, config } = usePopup();
  if (!clientId) return null;
  const grants = scope?.split(/\s+/) ?? [];
  const name = (config as { ui_theme?: { logo?: { alt?: string } } } | null)?.ui_theme?.logo?.alt;
  const access = [];
  if (grants.includes('profile') || grants.includes('email')) access.push('your profile');
  if (grants.includes('settings.write')) access.push('permission to read and save your personal settings, including favourites');
  else if (grants.includes('settings.read')) access.push('permission to read your personal settings, including favourites');
  return <div className="my-4 text-sm text-[var(--uoa-color-muted)]">
    {name ? <p className="mb-2 font-medium text-[var(--uoa-color-text)]">{name}</p> : null}
    {access.length ? <p>Signing in gives this app {access.join(' and ')}.</p> : null}
    <p className="mt-1 break-all">Return to: {redirectUrl}</p>
  </div>;
}
