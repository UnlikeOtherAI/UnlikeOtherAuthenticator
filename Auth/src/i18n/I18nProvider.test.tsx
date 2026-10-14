// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider, useI18n } from './I18nProvider.js';
import { loadTranslations } from './language-loader.js';
vi.mock('./language-loader.js', () => ({ loadTranslations: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.resetAllMocks());
function Probe() {
  return <div>{useI18n().t('auth.login.title')}</div>;
}
it('uses one successful remote response even when it is partial', async () => {
  vi.mocked(loadTranslations).mockResolvedValue({ 'auth.login.title': 'Connexion' });
  const host = document.createElement('div');
  const root = createRoot(host);
  const config = { language_config: 'fr' };
  await act(async () => {
    root.render(
      <React.StrictMode>
        <I18nProvider config={config} configUrl="https://product.example/config">
          <Probe />
        </I18nProvider>
      </React.StrictMode>,
    );
  });
  const calls = vi.mocked(loadTranslations).mock.calls.length;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(host.textContent).toBe('Connexion');
  expect(loadTranslations).toHaveBeenCalledTimes(calls);
  await act(async () => root.unmount());
});
