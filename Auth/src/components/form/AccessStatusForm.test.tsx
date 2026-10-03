// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessStatusForm } from './AccessStatusForm.js';

const mocks = vi.hoisted(() => ({ post: vi.fn(), context: { configUrl: 'https://product.example/config', clientId: null as string | null, redirectUrl: null as string | null } }));
vi.mock('../../hooks/use-popup.js', () => ({ usePopup: () => mocks.context }));
vi.mock('../../i18n/use-translation.js', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../utils/api.js', () => ({ postJson: mocks.post }));
vi.mock('../../hooks/use-theme.js', () => ({ useTheme: () => ({ classNames: {} }) }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.post.mockReset(); mocks.context = { configUrl: 'https://product.example/config', clientId: null, redirectUrl: null };
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
function button(text: string) {
  const found = [...host.querySelectorAll('button')].find(element => element.textContent === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
async function open() { await act(async () => root.render(<AccessStatusForm />)); await act(async () => button('auth.accessStatus.open').click()); }
async function fill(index: number, text: string) {
  const input = host.querySelectorAll('input')[index];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => { setter?.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function submit() { await act(async () => host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }

describe('read-only access status flow', () => {
  it('proves mailbox and TOTP under signed config, then displays parent reason without a login grant', async () => {
    mocks.post.mockResolvedValueOnce({ ok: true, data: { challengeId: 'challenge' } }).mockResolvedValueOnce({ ok: true, data: {
      user: { id: 'subject', status: 'ACTIVE', reason: null }, organisations: [],
      teams: [{ id: 'team', status: 'ACTIVE', reason: null, parent: { id: 'org', status: 'DISABLED', reason: 'Contact support.' } }],
    } });
    await open(); await fill(0, 'person@example.com'); await submit();
    expect(host.textContent).toContain('auth.accessStatus.sent');
    await fill(0, '123456'); await fill(1, '654321'); await submit();
    expect(mocks.post.mock.calls).toEqual([
      ['/auth/lifecycle-status/start', { email: 'person@example.com' }, { config_url: mocks.context.configUrl }],
      ['/auth/lifecycle-status/verify', { challengeId: 'challenge', code: '123456', twoFactorCode: '654321' }, { config_url: mocks.context.configUrl }],
    ]);
    expect(host.textContent).toContain('Contact support.'); expect(host.querySelector('form')).toBeNull();
  });
  it('uses exact registered native context and keeps a failed proof retryable', async () => {
    mocks.context = { configUrl: '', clientId: 'public-app', redirectUrl: 'app://oauth/callback' };
    mocks.post.mockResolvedValueOnce({ ok: true, data: { challengeId: 'native-proof' } }).mockResolvedValueOnce({ ok: false, status: 401 });
    await open(); await fill(0, 'person@example.com'); await submit(); await fill(0, '123456'); await submit();
    expect(mocks.post.mock.calls[0][0]).toBe('/oauth/lifecycle-status/start');
    expect(mocks.post.mock.calls[0][2]).toEqual({ client_id: 'public-app', redirect_uri: 'app://oauth/callback' });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('auth.accessStatus.failed');
    await act(async () => button('auth.accessStatus.restart').click());
    expect(host.querySelector('input[type="email"]')).not.toBeNull();
  });
});
