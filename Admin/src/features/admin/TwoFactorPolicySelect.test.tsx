// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ORGANISATION_TWOFA_POLICY_OPTIONS, TwoFactorPolicySelect } from './TwoFactorPolicySelect';
afterEach(cleanup);
it('shows a failed policy save and retries the same selected policy', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
  render(<TwoFactorPolicySelect title="Two-factor authentication" description="Policy" value="inherit" options={ORGANISATION_TWOFA_POLICY_OPTIONS} onSave={save} />);
  const user = userEvent.setup();
  await user.selectOptions(screen.getByRole('combobox'), 'required');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(save).toHaveBeenCalledWith('required');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(save).toHaveBeenCalledTimes(2);
});
