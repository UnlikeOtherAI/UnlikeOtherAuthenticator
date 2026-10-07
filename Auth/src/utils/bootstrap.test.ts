// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { readClientBootstrap } from './bootstrap.js';

const runtime = window as unknown as Record<string, unknown>;
afterEach(() => {
  delete runtime.__UOA_ACCESS_STATUS_ENABLED__;
  delete runtime.__UOA_CLIENT_CONFIG__;
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
});
it('defaults off independently of product config, URL and local storage', () => {
  runtime.__UOA_CLIENT_CONFIG__ = {
    accessStatusEnabled: true,
    AUTH_ACCESS_STATUS_ENABLED: true,
    debug_enabled: true,
  };
  window.history.replaceState({}, '', '?access_status_enabled=true');
  window.localStorage.setItem('AUTH_ACCESS_STATUS_ENABLED', 'true');
  expect(readClientBootstrap().accessStatusEnabled).toBe(false);
  expect(
    readClientBootstrap({ serverConfig: runtime.__UOA_CLIENT_CONFIG__ }).accessStatusEnabled,
  ).toBe(false);
});
it.each([undefined, false, 'true', true])(
  'uses only the explicit boolean server bootstrap: %s',
  (value) => {
    runtime.__UOA_ACCESS_STATUS_ENABLED__ = value;
    expect(readClientBootstrap().accessStatusEnabled).toBe(value === true);
  },
);
it('uses explicit SSR state instead of a client global', () => {
  runtime.__UOA_ACCESS_STATUS_ENABLED__ = true;
  expect(
    readClientBootstrap({ serverConfig: {}, serverAccessStatusEnabled: false }).accessStatusEnabled,
  ).toBe(false);
  expect(
    readClientBootstrap({ serverConfig: {}, serverAccessStatusEnabled: true }).accessStatusEnabled,
  ).toBe(true);
});
