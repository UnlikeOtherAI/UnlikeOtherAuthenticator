// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DebugFab } from './DebugFab';
import { issueAdminDebugLogin } from '../services/admin-debug-login-service';
vi.mock('../services/admin-debug-login-service', () => ({ issueAdminDebugLogin: vi.fn() }));
describe('Debug login issuer', () => {
  afterEach(() => { cleanup(); vi.resetAllMocks(); });
  it('copies exactly the capability JSON and renews by invalidating the prior code', async () => {
    const user = userEvent.setup();
    vi.mocked(issueAdminDebugLogin).mockResolvedValueOnce({ url: 'https://admin.example/admin/login', token: 'a'.repeat(43), expires_in: 1800 })
      .mockResolvedValueOnce({ url: 'https://admin.example/admin/login', token: 'b'.repeat(43), expires_in: 900 });
    render(<DebugFab />);
    await user.click(screen.getByRole('button', { name: 'Debug login' }));
    await user.click(screen.getByRole('button', { name: 'Create code' }));
    const json = JSON.parse((screen.getByLabelText('Debug login JSON') as HTMLTextAreaElement).value);
    expect(Object.keys(json).sort()).toEqual(['token', 'url']);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe(JSON.stringify(json, null, 2));
    await user.click(screen.getByRole('button', { name: 'Renew' }));
    expect(issueAdminDebugLogin).toHaveBeenLastCalledWith('a'.repeat(43));
    expect((screen.getByLabelText('Debug login JSON') as HTMLTextAreaElement).value).toContain('b'.repeat(43));
  });
  it('keeps failed issuance visible and retryable', async () => {
    vi.mocked(issueAdminDebugLogin).mockRejectedValue(new Error('rejected'));
    const user = userEvent.setup(); render(<DebugFab />);
    await user.click(screen.getByRole('button', { name: 'Debug login' }));
    await user.click(screen.getByRole('button', { name: 'Create code' }));
    expect(screen.getByRole('alert').textContent).toContain('Sign in again');
    expect(screen.getByRole('button', { name: 'Create code' }).hasAttribute('disabled')).toBe(false);
  });
});
