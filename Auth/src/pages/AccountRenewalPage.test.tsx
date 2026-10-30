// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountRenewalPage } from './AccountRenewalPage.js';

const mocks = vi.hoisted(() => ({ post: vi.fn(), setView: vi.fn() }));
vi.mock('../hooks/use-popup.js', () => ({ usePopup: () => ({
  configUrl: 'https://fermentea.live/auth/config', pendingEmail: 'reviewer@example.com', setView: mocks.setView,
}) }));
vi.mock('../hooks/use-theme.js', () => ({ useTheme: () => ({ classNames: {} }) }));
vi.mock('../i18n/use-translation.js', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../utils/api.js', () => ({ postJson: mocks.post }));

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.post.mockReset(); mocks.setView.mockReset();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function submit() {
  await act(async () => host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
async function fill(index: number, value: string) {
  const input = host.querySelectorAll('input')[index];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => { setter?.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

it('verifies the mailbox and 2FA before sending the renewal request', async () => {
  mocks.post.mockResolvedValueOnce({ ok: true, data: { challengeId: 'challenge-1' } })
    .mockResolvedValueOnce({ ok: true, data: { ok: true } });
  await act(async () => root.render(<AccountRenewalPage />));
  await submit();
  expect(host.textContent).toContain('auth.renewal.codeSent');
  await fill(0, '123456'); await fill(1, '654321'); await submit();
  expect(mocks.post.mock.calls).toEqual([
    ['/auth/account-renewal/start', { email: 'reviewer@example.com' }, { config_url: 'https://fermentea.live/auth/config' }],
    ['/auth/account-renewal/request', { challengeId: 'challenge-1', code: '123456', twoFactorCode: '654321' },
      { config_url: 'https://fermentea.live/auth/config' }],
  ]);
  expect(host.textContent).toContain('auth.renewal.sent');
  expect(host.querySelector('form')).toBeNull();
});
