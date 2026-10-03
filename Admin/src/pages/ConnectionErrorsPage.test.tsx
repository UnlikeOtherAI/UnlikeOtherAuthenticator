// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectionErrorsPage } from './ConnectionErrorsPage';

const mocks = vi.hoisted(() => ({ isError: false, refetch: vi.fn() }));
const error = {
  id: 'error-1', ts: '2026-10-03 12:00:00', app: 'Example app', appId: 'example-app', domain: 'example.com', organisation: 'Example organisation',
  endpoint: '/auth/start', phase: 'jwt_verify', statusCode: 400, errorCode: 'CONFIG_INVALID', summary: 'The configuration signature cannot be verified.',
  details: ['Signing key was not found.'], missingClaims: ['config_url'], ip: '127.0.0.1', userAgent: 'Example browser', requestId: 'request-1',
  requestJson: {}, responseJson: {}, jwtHeader: {}, jwtPayload: {}, redactions: ['token'],
};
vi.mock('../features/admin/admin-queries', () => ({ useHandshakeErrorsQuery: () => ({ data: mocks.isError ? undefined : [error], isError: mocks.isError, refetch: mocks.refetch }) }));
afterEach(cleanup);
beforeEach(() => { mocks.isError = false; mocks.refetch.mockReset(); document.cookie = 'uoa-admin-connection-error-open-sections=; Max-Age=0'; });

it('keeps diagnostic fields removed from the compact list in addressable detail', async () => {
  render(<MemoryRouter initialEntries={['/connection-errors?selected=error-1']}><ConnectionErrorsPage /></MemoryRouter>);
  const summary = screen.getByRole('button', { name: 'Summary' });
  if (summary.getAttribute('aria-expanded') !== 'true') await userEvent.setup().click(summary);
  for (const text of [error.summary, error.organisation, error.app, error.appId, error.endpoint, error.missingClaims[0]]) {
    expect(screen.getByText(text)).toBeTruthy();
  }
});
it('shows an actionable error without falsely claiming the log is empty', async () => {
  mocks.isError = true;
  render(<MemoryRouter><ConnectionErrorsPage /></MemoryRouter>);
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.queryByText('No connection errors match the filters.')).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
  expect(mocks.refetch).toHaveBeenCalledOnce();
});
