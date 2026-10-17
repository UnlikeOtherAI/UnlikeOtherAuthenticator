// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionForm } from '../src/components/organisation/ConnectionForm.js';

vi.mock('../src/hooks/use-access-translation.js', () => ({ useAccessTranslation: () => (key: string) => key }));
vi.mock('../src/hooks/use-theme.js', () => ({ useTheme: () => ({ classNames: {} }) }));
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function fill(label: string, value: string) {
  const element = [...host.querySelectorAll('label')].find((item) => item.textContent === label);
  const input = document.getElementById(element?.htmlFor ?? '');
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
describe('provider connection setup', () => {
  it('keeps a failed save editable and clears the write-only secret only on confirmed success', async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await act(async () => root.render(<ConnectionForm preset="okta" protocol="oidc"
      busy={false} onSave={save} onBack={() => {}} />));
    await fill('issuer', 'https://company.okta.com'); await fill('clientId', 'app-id'); await fill('secret', 'write-only');
    await submit();
    expect(host.querySelector('input[type="password"]')?.getAttribute('value')).toBe('write-only');
    expect(save.mock.calls[0][0]).toMatchObject({ configuration: { issuer: 'https://company.okta.com', client_id: 'app-id' } });
    expect(save.mock.calls[0][0].configuration).not.toHaveProperty('trusted_origins');
    expect(save.mock.calls[0][0].configuration).not.toHaveProperty('tenant');
    expect(host.textContent).not.toContain('authorizeUrl');
    await submit(); expect((host.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
  });
  it('shows the reserved reply URL before asking for provider credentials', async () => {
    await act(async () => root.render(<ConnectionForm preset="entra" protocol="oidc" busy={false}
      onSave={async () => true} onBack={() => {}} existing={{ id: 'c', preset: 'entra', protocol: 'oidc',
        display_name: 'Corporate', status: 'draft', revision: 1, configuration: {}, secret_configured: false,
        tested_revision: null, callback_url: 'https://auth.example/sso/oidc/c/callback' }} />));
    expect(host.querySelector('code')?.textContent).toBe('https://auth.example/sso/oidc/c/callback');
    expect(host.textContent?.indexOf('callback')).toBeLessThan(host.textContent?.indexOf('clientId') ?? 0);
  });
});
